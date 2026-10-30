import 'reflect-metadata';
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../src/infrastructure/persistence/mikro-orm.config';
import { RetentionPurgeService } from '../src/infrastructure/persistence/retention/retention-purge.service';

function argument(name: string): string | undefined {
  const index = Bun.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : Bun.argv[index + 1];
}

function positiveInteger(value: string | undefined, fallback: number, field: string): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${field} must be an integer greater than or equal to 1`);
  }
  return parsed;
}

async function main(): Promise<void> {
  const dryRun = !Bun.argv.includes('--execute');
  const inboxDays = positiveInteger(
    argument('inbox-days') ?? process.env.RETENTION_INBOX_DAYS,
    30,
    '--inbox-days'
  );
  const outboxDays = positiveInteger(
    argument('outbox-days') ?? process.env.RETENTION_OUTBOX_DAYS,
    90,
    '--outbox-days'
  );
  const batchSize = positiveInteger(
    argument('batch-size') ?? process.env.RETENTION_BATCH_SIZE,
    1000,
    '--batch-size'
  );

  const orm = await MikroORM.init(config);
  try {
    const service = new RetentionPurgeService(orm);
    const result = await service.run({ inboxDays, outboxDays, batchSize, dryRun });
    console.log(JSON.stringify({ event: 'retention_purge_completed', ...result }));
  } finally {
    await orm.close(true);
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
