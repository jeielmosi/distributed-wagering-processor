import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { EntityManager } from '@mikro-orm/postgresql';
import { RetentionPurgeService } from '../../src/infrastructure/persistence/retention/retention-purge.service';
import { WagerTransactionStatus } from '../../src/domain/wager-transaction/wager-transaction-status';
import { ensurePostgres, PostgresHarness, SuiteDatabase } from './support/postgres-harness';
import {
  captureError,
  insertInboxMessage,
  insertLedgerEntry,
  insertOutboxMessage,
  insertTransaction,
  insertWallet,
  newId
} from './support/sql-fixtures';

const DAY_MS = 86_400_000;

describe('Retention purge', () => {
  let harness: PostgresHarness;
  let database: SuiteDatabase;
  let em: EntityManager;
  let service: RetentionPurgeService;

  beforeAll(async () => {
    harness = await ensurePostgres();
    database = await harness.createSuiteDatabase('retention');
    em = database.orm.em.fork();
    service = new RetentionPurgeService(database.orm);
  }, 180000);

  afterAll(async () => {
    await database?.close();
    await harness?.stop();
  }, 180000);

  test('dry-run conta elegíveis, execute arquiva e remove apenas terminais antigos', async () => {
    const now = new Date();
    const old = (days: number): Date => new Date(now.getTime() - days * DAY_MS);

    await insertInboxMessage(em, {
      messageId: 'old-1',
      receivedAt: old(41),
      processedAt: old(40)
    });
    await insertInboxMessage(em, {
      messageId: 'old-2',
      receivedAt: old(41),
      processedAt: old(40)
    });
    await insertInboxMessage(em, {
      messageId: 'recent',
      receivedAt: old(11),
      processedAt: old(10)
    });
    await insertInboxMessage(em, { messageId: 'pending', receivedAt: old(1), processedAt: null });

    await insertOutboxMessage(em, {
      id: '00000000-0000-7000-8000-000000000001',
      occurredAt: old(101),
      nextAttemptAt: old(101),
      publishedAt: old(100)
    });
    await insertOutboxMessage(em, {
      id: '00000000-0000-7000-8000-000000000002',
      occurredAt: old(101),
      nextAttemptAt: old(101),
      deadLetteredAt: old(100)
    });
    await insertOutboxMessage(em, {
      id: '00000000-0000-7000-8000-000000000003',
      occurredAt: old(11),
      nextAttemptAt: old(11),
      publishedAt: old(10)
    });
    await insertOutboxMessage(em, {
      id: '00000000-0000-7000-8000-000000000004',
      occurredAt: old(1),
      nextAttemptAt: old(1)
    });

    const walletId = await insertWallet(em);
    const playerId = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';
    const transactionId = await insertTransaction(em, {
      walletId,
      playerId,
      status: WagerTransactionStatus.Processed,
      amount: '10.00',
      balanceAfterAmount: '90.00',
      balanceAfterCurrency: 'BRL'
    });
    await insertLedgerEntry(em, {
      walletId,
      transactionId,
      walletVersion: 2,
      amount: '10.00',
      balanceBeforeAmount: '100.00',
      balanceAfterAmount: '90.00'
    });

    const dryRun = await service.run({ inboxDays: 30, outboxDays: 90, batchSize: 1, dryRun: true });
    expect(dryRun).toMatchObject({ dryRun: true, inboxArchived: 2, outboxArchived: 2 });

    const unchanged = await em.execute<{ inbox: number; outbox: number }[]>(
      `select
         (select count(*)::int from inbox_messages) as inbox,
         (select count(*)::int from outbox_messages) as outbox`
    );
    expect(unchanged[0]).toEqual({ inbox: 4, outbox: 4 });

    const executed = await service.run({
      inboxDays: 30,
      outboxDays: 90,
      batchSize: 1,
      dryRun: false
    });
    expect(executed).toMatchObject({ dryRun: false, inboxArchived: 2, outboxArchived: 2 });

    const remaining = await em.execute<{ table_name: string; count: number }[]>(
      `select 'inbox_messages' as table_name, count(*)::int as count from inbox_messages
       union all
       select 'inbox_messages_archive', count(*)::int from inbox_messages_archive
       union all
       select 'outbox_messages', count(*)::int from outbox_messages
       union all
       select 'outbox_messages_archive', count(*)::int from outbox_messages_archive
       union all
       select 'wager_transactions', count(*)::int from wager_transactions
       union all
       select 'wallet_ledger_entries', count(*)::int from wallet_ledger_entries`
    );
    const byTable = Object.fromEntries(remaining.map((row) => [row.table_name, row.count]));
    expect(byTable).toEqual({
      inbox_messages: 2,
      inbox_messages_archive: 2,
      outbox_messages: 2,
      outbox_messages_archive: 2,
      wager_transactions: 2,
      wallet_ledger_entries: 2
    });
  }, 120000);

  test('tabelas de arquivo rejeitam linhas inválidas', async () => {
    const inboxError = await captureError(() =>
      em.execute(
        `insert into inbox_messages_archive
           (message_id, consumer_name, payload_hash, correlation_id, received_at, processed_at, archived_at)
         values ('msg', 'consumer', 'not-a-hash', null, now(), now(), now())`
      )
    );
    expect(inboxError.message).toContain('chk_inbox_archive_payload_hash');

    const outboxError = await captureError(() =>
      em.execute(
        `insert into outbox_messages_archive
           (id, aggregate_id, event_type, payload, correlation_id, occurred_at,
            attempts, claim_count, next_attempt_at, published_at, dead_lettered_at, last_error, archived_at)
         values (?, ?, 'WagerTransactionProcessed', '{}'::jsonb, null, now(),
                 -1, 0, now(), null, null, null, now())`,
        [newId(), newId()]
      )
    );
    expect(outboxError.message).toContain('chk_outbox_archive_attempts');
  });
});
