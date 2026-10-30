import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { SuiteDatabase } from '../../integration/support/postgres-harness';
import { LocalStackHarness } from '../../integration/support/localstack-harness';
import { describeError, logCleanupFailure, logTestEvent } from '../../support/test-log';

const PROJECT_ROOT = resolve(__dirname, '../../..');

export interface SpawnAppOptions {
  database: SuiteDatabase;
  localstack: LocalStackHarness;
  instanceId: string;
  port?: number;
  messaging?: boolean;
  visibilityTimeoutSeconds?: number;
  environment?: Record<string, string>;
}

export interface AppProcess {
  readonly port: number;
  readonly instanceId: string;
  readonly baseUrl: string;
  readonly exitCode: number | null;
  readonly exited: Promise<number>;
  waitForExit(timeoutMs: number): Promise<number>;
  terminate(timeoutMs: number): Promise<number>;
  logs(): string;
  stop(): Promise<void>;
}

async function reservePort(): Promise<number> {
  return new Promise<number>((resolvePort, rejectPort) => {
    const server = createServer();
    server.once('error', rejectPort);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        rejectPort(new Error('Could not reserve a TCP port'));
        return;
      }
      const port = address.port;
      server.close(() => resolvePort(port));
    });
  });
}

function collect(
  label: string,
  stream: ReadableStream<Uint8Array> | null | undefined
): {
  text(): string;
  done: Promise<void>;
} {
  let buffer = '';
  const decoder = new TextDecoder();
  if (stream === null || stream === undefined) {
    return { text: () => buffer, done: Promise.resolve() };
  }
  const done = (async () => {
    const reader = stream.getReader();
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) {
          break;
        }
        if (chunk.value !== undefined) {
          buffer += decoder.decode(chunk.value, { stream: true });
        }
      }
    } catch (error) {
      // The stream is closed when the child exits; partial output is still useful.
      logCleanupFailure(`${label} log stream`, error);
    } finally {
      buffer += decoder.decode();
    }
  })();
  return { text: () => buffer, done };
}

export function buildAppEnvironment(
  options: SpawnAppOptions,
  port: number
): Record<string, string> {
  const messaging = options.messaging === true;
  return {
    ...process.env,
    NODE_ENV: 'test',
    PORT: String(port),
    INSTANCE_ID: options.instanceId,
    DATABASE_URL: options.database.url,
    SQS_ENDPOINT: options.localstack.endpoint,
    AWS_DEFAULT_REGION: options.localstack.region,
    AWS_ACCESS_KEY_ID: 'test',
    AWS_SECRET_ACCESS_KEY: 'test',
    SQS_WAGER_QUEUE_URL: options.localstack.queues.wager,
    SQS_WAGER_DLQ_QUEUE_URL: options.localstack.queues.wagerDlq,
    SQS_EVENTS_QUEUE_URL: options.localstack.queues.events,
    SQS_EVENTS_DLQ_QUEUE_URL: options.localstack.queues.eventsDlq,
    SQS_VISIBILITY_TIMEOUT: String(options.visibilityTimeoutSeconds ?? 60),
    SQS_MAX_NUMBER_OF_MESSAGES: '1',
    MESSAGING_ENABLED: messaging ? '1' : '0',
    FAULT_AFTER_COMMIT_BEFORE_ACK: '0',
    FAULT_AFTER_PUBLISH_BEFORE_MARK: '0',
    SQS_CONSUMER_MAX_RECEIVE_COUNT: '5',
    MESSAGING_POLL_INTERVAL_MS: '200',
    MESSAGING_DRAIN_TIMEOUT_MS: '30000',
    OUTBOX_BATCH_SIZE: '10',
    OUTBOX_PUBLISH_CONCURRENCY: '4',
    OUTBOX_LEASE_MS: '30000',
    PENDING_BATCH_SIZE: '10',
    PENDING_LEASE_MS: '30000',
    ...(options.environment ?? {})
  } as Record<string, string>;
}

export async function spawnApp(options: SpawnAppOptions): Promise<AppProcess> {
  const port = options.port ?? (await reservePort());
  const child = Bun.spawn({
    cmd: [process.execPath, 'src/main.ts'],
    cwd: PROJECT_ROOT,
    env: buildAppEnvironment(options, port),
    stdout: 'pipe',
    stderr: 'pipe'
  });
  const stderrCollector = collect(
    `${options.instanceId} stderr`,
    child.stderr as ReadableStream<Uint8Array> | null
  );
  const stdoutCollector = collect(
    `${options.instanceId} stdout`,
    child.stdout as ReadableStream<Uint8Array> | null
  );

  const baseUrl = `http://127.0.0.1:${port}`;
  const logs = (): string => `${stdoutCollector.text()}${stderrCollector.text()}`;
  const deadline = Date.now() + 45_000;
  let lastError: unknown;
  let lastStatus: number | undefined;
  let loggedError: string | undefined;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      await Promise.race([
        Promise.all([stdoutCollector.done, stderrCollector.done]),
        Bun.sleep(500)
      ]);
      throw new Error(
        `App process ${options.instanceId} exited with code ${child.exitCode} before ready\n${logs()}`
      );
    }
    try {
      const response = await fetch(`${baseUrl}/health/live`, {
        signal: AbortSignal.timeout(1000)
      });
      lastStatus = response.status;
      if (response.ok) {
        return {
          port,
          instanceId: options.instanceId,
          baseUrl,
          get exitCode() {
            return child.exitCode;
          },
          exited: child.exited,
          async waitForExit(timeoutMs: number): Promise<number> {
            const outcome = await Promise.race([
              child.exited,
              Bun.sleep(timeoutMs).then(() => 'timeout' as const)
            ]);
            if (outcome === 'timeout') {
              throw new Error(
                `App process ${options.instanceId} did not exit within ${timeoutMs}ms\n${logs()}`
              );
            }
            return outcome;
          },
          async terminate(timeoutMs: number): Promise<number> {
            if (child.exitCode === null) {
              child.kill('SIGTERM');
            }
            const outcome = await Promise.race([
              child.exited,
              Bun.sleep(timeoutMs).then(() => 'timeout' as const)
            ]);
            if (outcome === 'timeout') {
              child.kill('SIGKILL');
              throw new Error(
                `App process ${options.instanceId} ignored SIGTERM for ${timeoutMs}ms\n${logs()}`
              );
            }
            return outcome;
          },
          logs,
          async stop(): Promise<void> {
            if (child.exitCode === null) {
              child.kill();
              const graceful = await Promise.race([child.exited, Bun.sleep(5000).then(() => null)]);
              if (graceful === null && child.exitCode === null) {
                child.kill('SIGKILL');
                await child.exited;
              }
            }
            await Promise.race([
              Promise.all([stdoutCollector.done, stderrCollector.done]),
              Bun.sleep(1000)
            ]);
          }
        };
      }
    } catch (error) {
      // The process is still booting; keep polling until the deadline.
      lastError = error;
      const description = describeError(error);
      if (description !== loggedError) {
        loggedError = description;
        logTestEvent(`cluster[${options.instanceId}] health poll`, error);
      }
    }
    await Bun.sleep(100);
  }

  child.kill('SIGKILL');
  await Promise.race([child.exited, Bun.sleep(1000)]);
  await Promise.race([Promise.all([stdoutCollector.done, stderrCollector.done]), Bun.sleep(500)]);
  throw new Error(
    `App process ${options.instanceId} was not ready within 45s` +
      `${lastStatus === undefined ? '' : ` (last HTTP status ${lastStatus})`}` +
      `${lastError === undefined ? '' : `, last error: ${describeError(lastError)}`}\n${logs()}`
  );
}
