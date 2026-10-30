import { GenericContainer, StartedTestContainer, Wait } from 'testcontainers';
import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  PurgeQueueCommand,
  SQSClient
} from '@aws-sdk/client-sqs';
import { logCleanupFailure, logTestEvent } from '../../support/test-log';

const LOCALSTACK_IMAGE = 'localstack/localstack:4.4.0';
const REGION = 'us-east-1';

export interface LocalStackQueues {
  wager: string;
  wagerDlq: string;
  events: string;
  eventsDlq: string;
}

export interface LocalStackHarness {
  endpoint: string;
  region: string;
  queues: LocalStackQueues;
  client: SQSClient;
  purgeAll(): Promise<void>;
  stop(): Promise<void>;
}

let started: Promise<LocalStackHarness> | undefined;

function clientFor(endpoint: string): SQSClient {
  return new SQSClient({
    endpoint,
    region: REGION,
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' }
  });
}

async function createQueue(
  client: SQSClient,
  name: string,
  attributes?: Record<string, string>
): Promise<string> {
  await client.send(
    new CreateQueueCommand({
      QueueName: name,
      ...(attributes === undefined ? {} : { Attributes: attributes })
    })
  );
  const response = await client.send(new GetQueueUrlCommand({ QueueName: name }));
  if (response.QueueUrl === undefined) {
    throw new Error(`Queue ${name} has no URL`);
  }
  return response.QueueUrl;
}

async function queueArn(client: SQSClient, queueUrl: string): Promise<string> {
  const response = await client.send(
    new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ['QueueArn']
    })
  );
  const arn = response.Attributes?.QueueArn;
  if (arn === undefined) {
    throw new Error(`Queue ${queueUrl} has no ARN`);
  }
  return arn;
}

async function start(): Promise<LocalStackHarness> {
  const container: StartedTestContainer = await new GenericContainer(LOCALSTACK_IMAGE)
    .withEnvironment({ SERVICES: 'sqs', AWS_DEFAULT_REGION: REGION })
    .withExposedPorts(4566)
    .withWaitStrategy(Wait.forHttp('/_localstack/health', 4566).withStartupTimeout(180000))
    .withStartupTimeout(180000)
    .start();

  const endpoint = `http://${container.getHost()}:${container.getMappedPort(4566)}`;
  const client = clientFor(endpoint);

  const wagerDlq = await createQueue(client, 'wager-transactions-dlq.fifo', {
    FifoQueue: 'true'
  });
  const eventsDlq = await createQueue(client, 'wagering-events-dlq.fifo', {
    FifoQueue: 'true'
  });
  const wagerDlqArn = await queueArn(client, wagerDlq);
  const eventsDlqArn = await queueArn(client, eventsDlq);
  const wager = await createQueue(client, 'wager-transactions.fifo', {
    FifoQueue: 'true',
    ContentBasedDeduplication: 'false',
    VisibilityTimeout: '60',
    RedrivePolicy: JSON.stringify({
      deadLetterTargetArn: wagerDlqArn,
      maxReceiveCount: '5'
    })
  });
  const events = await createQueue(client, 'wagering-events.fifo', {
    FifoQueue: 'true',
    ContentBasedDeduplication: 'false',
    RedrivePolicy: JSON.stringify({
      deadLetterTargetArn: eventsDlqArn,
      maxReceiveCount: '5'
    })
  });

  return {
    endpoint,
    region: REGION,
    queues: { wager, wagerDlq, events, eventsDlq },
    client,
    async purgeAll() {
      const failures: Array<{ url: string; error: unknown }> = [];
      for (const url of [wager, wagerDlq, events, eventsDlq]) {
        try {
          await client.send(new PurgeQueueCommand({ QueueUrl: url }));
        } catch (error) {
          const name = (error as { name?: unknown }).name;
          if (name === 'PurgeQueueInProgress') {
            // An empty queue may be reported as in progress; the queue is already draining.
            logTestEvent(`localstack purge ${url}`, error);
            continue;
          }
          logCleanupFailure(`localstack purge ${url}`, error);
          failures.push({ url, error });
        }
      }
      if (failures.length > 0) {
        throw new AggregateError(
          failures.map((failure) => failure.error),
          `Failed to purge ${failures.length} queue(s): ${failures.map((failure) => failure.url).join(', ')}`
        );
      }
    },
    async stop() {
      client.destroy();
      await container.stop();
      started = undefined;
    }
  };
}

export async function ensureLocalStack(): Promise<LocalStackHarness> {
  if (started === undefined) {
    started = start();
  }
  return started;
}
