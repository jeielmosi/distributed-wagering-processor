import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { EntityManager, MikroORM } from '@mikro-orm/postgresql';
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
import { WagerTransactionStatus } from '../../src/domain/wager-transaction/wager-transaction-status';
import { WagerTransactionKind } from '../../src/domain/wager-transaction/wager-transaction-kind';
import { LedgerDirection } from '../../src/domain/ledger/ledger-direction';
import { FailureCode } from '../../src/shared/errors/failure-code';

async function tableExists(em: EntityManager, table: string): Promise<boolean> {
  const rows = await em.execute<{ name: string | null }[]>('select to_regclass(?)::text as name', [
    `public.${table}`
  ]);
  return Array.isArray(rows) && rows[0]?.name != null;
}

describe('Persistence schema', () => {
  let harness: PostgresHarness;
  let database: SuiteDatabase;
  let em: EntityManager;

  beforeAll(async () => {
    harness = await ensurePostgres();
    database = await harness.createSuiteDatabase('schema');
    em = database.orm.em.fork();
  }, 180000);

  afterAll(async () => {
    await database?.close();
    await harness?.stop();
  }, 180000);

  test('migrations sobem, revertem e sobem novamente', async () => {
    const empty = await harness.createSuiteDatabase('migrations', { migrated: false });
    try {
      const migrator = empty.orm.getMigrator();
      await migrator.up();
      expect(await tableExists(empty.orm.em, 'wallets')).toBe(true);
      expect(await tableExists(empty.orm.em, 'wallet_ledger_entries')).toBe(true);

      while ((await migrator.getExecutedMigrations()).length > 0) {
        await migrator.down();
      }
      expect(await tableExists(empty.orm.em, 'wallets')).toBe(false);
      expect(await tableExists(empty.orm.em, 'wallet_ledger_entries')).toBe(false);

      await migrator.up();
      expect(await tableExists(empty.orm.em, 'wallets')).toBe(true);
      expect(await tableExists(empty.orm.em, 'outbox_messages')).toBe(true);
    } finally {
      await empty.close();
    }
  }, 120000);

  test('migration REFERENCE_REQUIRED reverte com transação terminal existente', async () => {
    const data = await harness.createSuiteDatabase('migration_reference');
    try {
      const dataEm = data.orm.em.fork();
      const walletId = await insertWallet(dataEm);
      await insertTransaction(dataEm, {
        walletId,
        playerId: newId(),
        kind: WagerTransactionKind.Bet,
        status: WagerTransactionStatus.Rejected,
        externalTransactionId: 'reference-required-terminal',
        failureCode: FailureCode.ReferenceRequired
      });

      const migrator = data.orm.getMigrator();
      await migrator.down();
      await migrator.down();

      const rows = await dataEm.execute<{ failure_code: string }[]>(
        'select failure_code from wager_transactions where external_transaction_id = ?',
        ['reference-required-terminal']
      );
      expect(rows[0]?.failure_code).toBe(FailureCode.PermanentInfraFailure);

      await migrator.up();
      await migrator.up();
    } finally {
      await data.close();
    }
  }, 120000);

  test('ledger bloqueia UPDATE, DELETE e TRUNCATE', async () => {
    const walletId = await insertWallet(em);
    const transactionId = await insertTransaction(em, {
      walletId,
      playerId: newId(),
      kind: WagerTransactionKind.Bet,
      status: WagerTransactionStatus.Processed,
      amount: '25.00',
      balanceAfterAmount: '75.00'
    });
    await insertLedgerEntry(em, {
      walletId,
      transactionId,
      walletVersion: 2,
      direction: LedgerDirection.Debit,
      amount: '25.00',
      balanceBeforeAmount: '100.00',
      balanceAfterAmount: '75.00'
    });

    const updateError = await captureError(() =>
      em.execute('update wallet_ledger_entries set amount = 1.00')
    );
    expect(updateError.message).toContain('immutable');

    const deleteError = await captureError(() => em.execute('delete from wallet_ledger_entries'));
    expect(deleteError.message).toContain('immutable');

    const truncateError = await captureError(() => em.execute('truncate wallet_ledger_entries'));
    expect(truncateError.message).toContain('immutable');

    const rows = await em.execute<{ count: number }[]>(
      'select count(*)::int as count from wallet_ledger_entries'
    );
    expect(rows[0]?.count).toBe(2);
  });

  test('wager_transactions bloqueia UPDATE de estado terminal', async () => {
    const playerId = newId();
    const walletId = await insertWallet(em, { playerId });

    for (const status of [
      WagerTransactionStatus.Processed,
      WagerTransactionStatus.Rejected,
      WagerTransactionStatus.Failed
    ]) {
      const transactionId = await insertTransaction(em, {
        walletId,
        playerId,
        kind: WagerTransactionKind.Bet,
        status,
        externalTransactionId: `terminal-${status}-${newId()}`,
        amount: '10.00',
        balanceAfterAmount: status === WagerTransactionStatus.Processed ? '90.00' : null
      });

      const error = await captureError(() =>
        em.execute('update wager_transactions set status = ? where id = ?', [
          WagerTransactionStatus.Pending,
          transactionId
        ])
      );
      expect(error.message).toContain('terminal state');
    }
  });

  test('balance_after_amount não aceita valor negativo', async () => {
    const playerId = newId();
    const walletId = await insertWallet(em, { playerId });

    const error = await captureError(() =>
      insertTransaction(em, {
        walletId,
        playerId,
        kind: WagerTransactionKind.Bet,
        status: WagerTransactionStatus.Processed,
        externalTransactionId: `negative-balance-${newId()}`,
        amount: '10.00',
        balanceAfterAmount: '-1.00'
      })
    );

    expect(error.message).toContain('chk_wager_tx_balance_after_non_negative');
  });

  test('referência de transação exige a mesma wallet', async () => {
    const firstPlayerId = newId();
    const firstWalletId = await insertWallet(em, { playerId: firstPlayerId });
    const secondPlayerId = newId();
    const secondWalletId = await insertWallet(em, { playerId: secondPlayerId });

    const betId = await insertTransaction(em, {
      walletId: firstWalletId,
      playerId: firstPlayerId,
      kind: WagerTransactionKind.Bet,
      status: WagerTransactionStatus.Processed,
      externalTransactionId: `bet-cross-wallet-${newId()}`,
      amount: '10.00',
      balanceAfterAmount: '90.00'
    });

    const error = await captureError(() =>
      insertTransaction(em, {
        walletId: secondWalletId,
        playerId: secondPlayerId,
        kind: WagerTransactionKind.Refund,
        status: WagerTransactionStatus.Pending,
        externalTransactionId: `refund-cross-wallet-${newId()}`,
        amount: '10.00',
        referenceExternalTransactionId: `bet-cross-wallet-${newId()}`,
        referenceTransactionId: betId
      })
    );

    expect(error.message).toContain('fk_wager_tx_reference_wallet');
  });

  test('reversão e settlement são únicos por alvo', async () => {
    const walletId = await insertWallet(em);
    const playerId = newId();
    const betId = await insertTransaction(em, {
      walletId,
      playerId,
      kind: WagerTransactionKind.Bet,
      status: WagerTransactionStatus.Processed,
      externalTransactionId: 'bet-external',
      amount: '10.00',
      balanceAfterAmount: '90.00'
    });

    await insertTransaction(em, {
      walletId,
      playerId,
      kind: WagerTransactionKind.Refund,
      status: WagerTransactionStatus.Processed,
      amount: '10.00',
      balanceAfterAmount: '100.00',
      referenceExternalTransactionId: 'bet-external',
      referenceTransactionId: betId
    });

    const reversalError = await captureError(() =>
      insertTransaction(em, {
        walletId,
        playerId,
        kind: WagerTransactionKind.Rollback,
        status: WagerTransactionStatus.Processed,
        amount: '10.00',
        balanceAfterAmount: '100.00',
        referenceExternalTransactionId: 'bet-external',
        referenceTransactionId: betId
      })
    );
    expect(reversalError.message).toContain('uq_wager_tx_reversal');

    await insertTransaction(em, {
      walletId,
      playerId,
      kind: WagerTransactionKind.Win,
      status: WagerTransactionStatus.Processed,
      amount: '20.00',
      balanceAfterAmount: '110.00',
      referenceExternalTransactionId: 'bet-external',
      referenceTransactionId: betId
    });

    const secondWin = await captureError(() =>
      insertTransaction(em, {
        walletId,
        playerId,
        kind: WagerTransactionKind.Win,
        status: WagerTransactionStatus.Processed,
        amount: '20.00',
        balanceAfterAmount: '130.00',
        referenceExternalTransactionId: 'bet-external',
        referenceTransactionId: betId
      })
    );
    expect(secondWin.message).toContain('uq_wager_tx_settlement');

    const lossAfterWin = await captureError(() =>
      insertTransaction(em, {
        walletId,
        playerId,
        kind: WagerTransactionKind.Loss,
        status: WagerTransactionStatus.Processed,
        amount: '20.00',
        referenceExternalTransactionId: 'bet-external',
        referenceTransactionId: betId
      })
    );
    expect(lossAfterWin.message).toContain('uq_wager_tx_settlement');
  });

  test('idempotência é isolada por provider e external id é único por provider', async () => {
    const walletId = await insertWallet(em);
    const playerId = newId();
    await insertTransaction(em, {
      walletId,
      playerId,
      providerId: 'provider-a',
      idempotencyKey: 'same-key',
      externalTransactionId: 'external-a'
    });

    const idempotencyError = await captureError(() =>
      insertTransaction(em, {
        walletId,
        playerId,
        providerId: 'provider-a',
        idempotencyKey: 'same-key',
        externalTransactionId: 'external-b'
      })
    );
    expect(idempotencyError.message).toContain('uq_wager_tx_idempotency_provider');

    await insertTransaction(em, {
      walletId,
      playerId,
      providerId: 'provider-b',
      idempotencyKey: 'same-key',
      externalTransactionId: 'external-c'
    });

    const duplicateExternal = await captureError(() =>
      insertTransaction(em, {
        walletId,
        playerId,
        providerId: 'provider-a',
        idempotencyKey: 'other-key',
        externalTransactionId: 'external-a'
      })
    );
    expect(duplicateExternal.message).toContain('uq_wager_tx_provider_external');
  });

  test('OPENING exige chave interna e é único por wallet', async () => {
    const walletId = await insertWallet(em, { balanceAmount: '0.00' });
    await insertTransaction(em, {
      walletId,
      playerId: newId(),
      kind: WagerTransactionKind.Opening,
      status: WagerTransactionStatus.Processed,
      amount: '10.00',
      balanceAfterAmount: '10.00'
    });

    const openingError = await captureError(() =>
      insertTransaction(em, {
        walletId,
        playerId: newId(),
        kind: WagerTransactionKind.Opening,
        status: WagerTransactionStatus.Processed,
        amount: '10.00',
        balanceAfterAmount: '10.00'
      })
    );
    expect(openingError.message).toMatch(
      /uq_wager_tx_opening_wallet|uq_wager_tx_idempotency_opening/
    );

    const keyError = await captureError(() =>
      insertTransaction(em, {
        walletId: newId(),
        playerId: newId(),
        kind: WagerTransactionKind.Opening,
        status: WagerTransactionStatus.Processed,
        idempotencyKey: 'not-internal',
        amount: '10.00',
        balanceAfterAmount: '10.00'
      })
    );
    expect(keyError.message).toContain('chk_wager_tx_opening_idempotency');
  });

  test('updated_at é mantido por trigger e resolved_at segue o estado', async () => {
    const createdAt = new Date('2000-01-01T00:00:00.000Z');
    const walletId = await insertWallet(em, { createdAt, updatedAt: createdAt });
    const before = await em.execute<{ updated_at: string }[]>(
      'select updated_at from wallets where id = ?',
      [walletId]
    );
    const firstUpdatedAt = new Date(String(before[0]?.updated_at ?? 0)).getTime();
    expect(firstUpdatedAt).toBeGreaterThan(createdAt.getTime());

    await em.execute("update wallets set updated_at = '2000-01-01T00:00:00Z' where id = ?", [
      walletId
    ]);
    const after = await em.execute<{ updated_at: string }[]>(
      'select updated_at from wallets where id = ?',
      [walletId]
    );
    expect(new Date(String(after[0]?.updated_at ?? 0)).getTime()).toBeGreaterThan(
      new Date('2000-01-01T00:00:00Z').getTime()
    );

    const playerId = newId();
    const missingResolved = await captureError(() =>
      insertTransaction(em, {
        walletId,
        playerId,
        status: WagerTransactionStatus.Processed,
        resolvedAt: null
      })
    );
    expect(missingResolved.message).toContain('chk_wager_tx_resolved_state');

    const pendingWithResolved = await captureError(() =>
      insertTransaction(em, {
        walletId,
        playerId,
        kind: WagerTransactionKind.Refund,
        status: WagerTransactionStatus.PendingReference,
        resolvedAt: new Date()
      })
    );
    expect(pendingWithResolved.message).toContain('chk_wager_tx_resolved_state');

    const missingProcessedAt = await captureError(() =>
      insertTransaction(em, {
        walletId,
        playerId,
        status: WagerTransactionStatus.Processed,
        processedAt: null
      })
    );
    expect(missingProcessedAt.message).toContain('chk_wager_tx_processed_snapshot');
  });

  test('wallets validam saldo, moeda e unicidade', async () => {
    const playerId = newId();
    await insertWallet(em, { playerId, currency: 'BRL' });

    const negative = await captureError(() => insertWallet(em, { balanceAmount: '-1.00' }));
    expect(negative.message).toContain('chk_wallets_balance_non_negative');

    const duplicate = await captureError(() => insertWallet(em, { playerId, currency: 'BRL' }));
    expect(duplicate.message).toContain('uq_wallets_player_currency');

    const currency = await captureError(() => insertWallet(em, { currency: 'brl' }));
    expect(currency.message).toContain('chk_wallets_currency');
  });

  test('invariante wallet↔ledger é verificada no commit', async () => {
    const walletId = await insertWallet(em);
    const playerId = newId();
    await insertTransaction(em, {
      walletId,
      playerId,
      status: WagerTransactionStatus.Pending,
      amount: '10.00'
    });

    const walletUpdateWithoutLedger = await captureError(() =>
      em.transactional(async (tx) => {
        await tx.execute('update wallets set balance_amount = 50.00, version = 2 where id = ?', [
          walletId
        ]);
      })
    );
    expect(walletUpdateWithoutLedger.message).toContain('ledger consistency');

    const otherWalletId = await insertWallet(em, { balanceAmount: '0.00' });
    const otherPlayerId = newId();
    const otherTransactionId = await insertTransaction(em, {
      walletId: otherWalletId,
      playerId: otherPlayerId,
      status: WagerTransactionStatus.Pending,
      amount: '10.00'
    });

    const ledgerWithoutWalletUpdate = await captureError(() =>
      em.transactional(async (tx) => {
        await tx.execute(
          `insert into wallet_ledger_entries (
             id, wallet_id, transaction_id, wallet_version, direction, amount, currency,
             balance_before_amount, balance_after_amount, created_at
           ) values (?, ?, ?, 1, 'CREDIT', 10.00, 'BRL', 0.00, 10.00, now())`,
          [newId(), otherWalletId, otherTransactionId]
        );
      })
    );
    expect(ledgerWithoutWalletUpdate.message).toContain('ledger consistency');

    const unbackedWallet = await captureError(() =>
      em.transactional(async (tx) => {
        await tx.execute(
          `insert into wallets (id, player_id, currency, balance_amount, version, created_at, updated_at)
           values (?, ?, 'BRL', 10.00, 1, now(), now())`,
          [newId(), newId()]
        );
      })
    );
    expect(unbackedWallet.message).toContain('ledger consistency');
  });

  test('wager_transactions valida kind, status, taxonomia e referências', async () => {
    const walletId = await insertWallet(em);
    const playerId = newId();

    const invalidKind = await captureError(() =>
      insertTransaction(em, { walletId, playerId, kind: 'NOPE' })
    );
    expect(invalidKind.message).toContain('chk_wager_tx_kind');

    const invalidStatus = await captureError(() =>
      insertTransaction(em, { walletId, playerId, status: 'NOPE' })
    );
    expect(invalidStatus.message).toContain('chk_wager_tx_status');

    const zeroAmount = await captureError(() =>
      insertTransaction(em, { walletId, playerId, amount: '0.00' })
    );
    expect(zeroAmount.message).toContain('chk_wager_tx_amount');

    const invalidHash = await captureError(() =>
      insertTransaction(em, { walletId, playerId, payloadHash: 'abc' })
    );
    expect(invalidHash.message).toContain('chk_wager_tx_payload_hash');

    const longKey = await captureError(() =>
      insertTransaction(em, { walletId, playerId, idempotencyKey: 'k'.repeat(256) })
    );
    expect(longKey.message).toMatch(
      /chk_wager_tx_idempotency_length|value too long for type character varying\(255\)/
    );

    const longProvider = await captureError(() =>
      insertTransaction(em, { walletId, playerId, providerId: 'p'.repeat(256) })
    );
    expect(longProvider.message).toMatch(
      /chk_wager_tx_provider_length|value too long for type character varying\(255\)/
    );

    const invalidFailure = await captureError(() =>
      insertTransaction(em, {
        walletId,
        playerId,
        status: WagerTransactionStatus.Rejected,
        failureCode: 'NOPE'
      })
    );
    expect(invalidFailure.message).toContain('chk_wager_tx_failure_code');

    const betReference = await captureError(() =>
      insertTransaction(em, {
        walletId,
        playerId,
        kind: WagerTransactionKind.Bet,
        referenceExternalTransactionId: 'other'
      })
    );
    expect(betReference.message).toContain('chk_wager_tx_bet_reference');

    const refundWithoutReference = await captureError(() =>
      insertTransaction(em, {
        walletId,
        playerId,
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: null
      })
    );
    expect(refundWithoutReference.message).toContain('chk_wager_tx_reference_by_kind');

    const openingWithProvider = await captureError(() =>
      insertTransaction(em, {
        walletId,
        playerId,
        kind: WagerTransactionKind.Opening,
        status: WagerTransactionStatus.Processed,
        providerId: 'provider-1',
        amount: '10.00',
        balanceAfterAmount: '10.00'
      })
    );
    expect(openingWithProvider.message).toContain('chk_wager_tx_kind_fields');

    const reversalWithoutTarget = await captureError(() =>
      insertTransaction(em, {
        walletId,
        playerId,
        kind: WagerTransactionKind.Refund,
        status: WagerTransactionStatus.Processed,
        referenceTransactionId: null
      })
    );
    expect(reversalWithoutTarget.message).toContain('chk_wager_tx_reversal_reference');

    const selfReference = await captureError(() => {
      const id = newId();
      return insertTransaction(em, {
        id,
        walletId,
        playerId,
        kind: WagerTransactionKind.Refund,
        status: WagerTransactionStatus.Processed,
        referenceTransactionId: id
      });
    });
    expect(selfReference.message).toContain('chk_wager_tx_self_reference');

    const acceptedFailure = await insertTransaction(em, {
      walletId,
      playerId,
      status: WagerTransactionStatus.Rejected,
      failureCode: FailureCode.ReferenceHasProcessedWin
    });
    expect(acceptedFailure).toBeDefined();
  });

  test('ledger valida aritmética, FK composta, versão e direction', async () => {
    const walletId = await insertWallet(em);
    const otherWalletId = await insertWallet(em);
    const playerId = newId();
    const transactionId = await insertTransaction(em, {
      walletId,
      playerId,
      status: WagerTransactionStatus.Processed,
      amount: '10.00',
      balanceAfterAmount: '90.00'
    });

    const debitArithmetic = await captureError(() =>
      insertLedgerEntry(em, {
        walletId,
        transactionId,
        balanceBeforeAmount: '100.00',
        balanceAfterAmount: '95.00',
        amount: '10.00',
        direction: LedgerDirection.Debit
      })
    );
    expect(debitArithmetic.message).toContain('chk_ledger_arithmetic');

    const creditArithmetic = await captureError(() =>
      insertLedgerEntry(em, {
        walletId,
        transactionId,
        walletVersion: 3,
        balanceBeforeAmount: '100.00',
        balanceAfterAmount: '95.00',
        amount: '10.00',
        direction: LedgerDirection.Credit
      })
    );
    expect(creditArithmetic.message).toContain('chk_ledger_arithmetic');

    const wrongWallet = await captureError(() =>
      insertLedgerEntry(em, {
        walletId: otherWalletId,
        transactionId,
        walletVersion: 2,
        direction: LedgerDirection.Debit,
        balanceBeforeAmount: '100.00',
        balanceAfterAmount: '90.00'
      })
    );
    expect(wrongWallet.message).toContain('fk_ledger_transaction');

    const invalidDirection = await captureError(() =>
      insertLedgerEntry(em, {
        walletId,
        transactionId,
        walletVersion: 2,
        direction: 'NOPE'
      })
    );
    expect(invalidDirection.message).toMatch(/chk_ledger_direction|chk_ledger_arithmetic/);

    const zeroAmount = await captureError(() =>
      insertLedgerEntry(em, {
        walletId,
        transactionId,
        walletVersion: 2,
        amount: '0.00'
      })
    );
    expect(zeroAmount.message).toContain('chk_ledger_amount');

    await insertLedgerEntry(em, {
      walletId,
      transactionId,
      walletVersion: 2
    });

    const duplicateVersion = await captureError(() =>
      insertLedgerEntry(em, {
        walletId,
        transactionId,
        walletVersion: 2
      })
    );
    expect(duplicateVersion.message).toMatch(
      /uq_ledger_wallet_version|uq_ledger_wallet_transaction/
    );
  });

  test('PENDING_REFERENCE exige janela coerente de retry', async () => {
    const walletId = await insertWallet(em);
    const playerId = newId();
    const now = new Date();

    const missingWindow = await captureError(() =>
      insertTransaction(em, {
        walletId,
        playerId,
        kind: WagerTransactionKind.Win,
        status: WagerTransactionStatus.PendingReference,
        nextReferenceAttemptAt: null,
        referenceExpiresAt: null
      })
    );
    expect(missingWindow.message).toContain('chk_wager_tx_pending_reference_fields');

    const outOfOrder = await captureError(() =>
      insertTransaction(em, {
        walletId,
        playerId,
        kind: WagerTransactionKind.Win,
        status: WagerTransactionStatus.PendingReference,
        nextReferenceAttemptAt: new Date(now.getTime() + 7200_000),
        referenceExpiresAt: new Date(now.getTime() + 3600_000)
      })
    );
    expect(outOfOrder.message).toContain('chk_wager_tx_pending_reference_order');

    const negativeAttempts = await captureError(() =>
      insertTransaction(em, {
        walletId,
        playerId,
        referenceAttempts: -1
      })
    );
    expect(negativeAttempts.message).toContain('chk_wager_tx_reference_attempts');
  });

  test('inbox valida hash, tamanho, PK e processed_at', async () => {
    const { messageId, consumerName } = await insertInboxMessage(em);

    const duplicate = await captureError(() => insertInboxMessage(em, { messageId, consumerName }));
    expect(duplicate.message).toContain('pk_inbox_messages');

    const invalidHash = await captureError(() => insertInboxMessage(em, { payloadHash: 'abc' }));
    expect(invalidHash.message).toContain('chk_inbox_payload_hash');

    const invalidProcessedAt = await captureError(() =>
      insertInboxMessage(em, {
        receivedAt: new Date('2026-01-01T00:00:00.000Z'),
        processedAt: new Date('2025-01-01T00:00:00.000Z')
      })
    );
    expect(invalidProcessedAt.message).toContain('chk_inbox_processed_at');

    const longCorrelation = await captureError(() =>
      insertInboxMessage(em, { correlationId: 'c'.repeat(256) })
    );
    expect(longCorrelation.message).toMatch(
      /chk_inbox_correlation_length|value too long for type character varying\(255\)/
    );
  });

  test('outbox valida janela, contadores e estado de publicação', async () => {
    const now = new Date();

    const missingNext = await captureError(() =>
      insertOutboxMessage(em, { nextAttemptAt: null as unknown as Date })
    );
    expect(missingNext.message).toContain('next_attempt_at');

    const beforeOccurred = await captureError(() =>
      insertOutboxMessage(em, {
        occurredAt: now,
        nextAttemptAt: new Date(now.getTime() - 1000)
      })
    );
    expect(beforeOccurred.message).toContain('chk_outbox_next_attempt_at');

    const bothTerminal = await captureError(() =>
      insertOutboxMessage(em, {
        occurredAt: new Date(now.getTime() - 1000),
        publishedAt: now,
        deadLetteredAt: now
      })
    );
    expect(bothTerminal.message).toContain('chk_outbox_published_or_dead_lettered');

    const negativeAttempts = await captureError(() => insertOutboxMessage(em, { attempts: -1 }));
    expect(negativeAttempts.message).toContain('chk_outbox_attempts');

    const emptyType = await captureError(() => insertOutboxMessage(em, { eventType: '' }));
    expect(emptyType.message).toContain('chk_outbox_event_type_length');

    const shortHash = await captureError(() =>
      insertOutboxMessage(em, { payload: {}, correlationId: 'c'.repeat(256) })
    );
    expect(shortHash.message).toMatch(
      /chk_outbox_correlation_length|value too long for type character varying\(255\)/
    );
  });

  test('índices parciais e triggers estruturais existem', async () => {
    const indexes = await em.execute<{ indexname: string }[]>(
      `select indexname from pg_indexes
        where schemaname = 'public'
          and indexname in (
            'uq_wager_tx_reversal',
            'uq_wager_tx_settlement',
            'uq_wager_tx_idempotency_provider',
            'uq_wager_tx_idempotency_opening',
            'uq_wager_tx_opening_wallet',
            'idx_wager_tx_pending_due',
            'idx_ledger_wallet_pagination',
            'idx_outbox_pending'
          )
        order by indexname`
    );
    expect(indexes.map((row) => row.indexname)).toEqual([
      'idx_ledger_wallet_pagination',
      'idx_outbox_pending',
      'idx_wager_tx_pending_due',
      'uq_wager_tx_idempotency_opening',
      'uq_wager_tx_idempotency_provider',
      'uq_wager_tx_opening_wallet',
      'uq_wager_tx_reversal',
      'uq_wager_tx_settlement'
    ]);

    const triggers = await em.execute<{ tgname: string }[]>(
      `select tgname from pg_trigger
        where not tgisinternal
          and tgname in (
            'trg_wallets_set_updated_at',
            'trg_wager_transactions_set_updated_at',
            'trg_prevent_ledger_modification',
            'trg_prevent_ledger_truncate'
          )
        order by tgname`
    );
    expect(triggers.map((row) => row.tgname)).toEqual([
      'trg_prevent_ledger_modification',
      'trg_prevent_ledger_truncate',
      'trg_wager_transactions_set_updated_at',
      'trg_wallets_set_updated_at'
    ]);
  });

  test('MikroORM carrega o schema esperado', async () => {
    const orm: MikroORM = database.orm;
    const names = orm.getMetadata().getAll();
    expect(names.WalletEntity).toBeDefined();
    expect(names.WagerTransactionEntity).toBeDefined();
    expect(names.WalletLedgerEntryEntity).toBeDefined();
    expect(names.InboxMessageEntity).toBeDefined();
    expect(names.OutboxMessageEntity).toBeDefined();
  });
});
