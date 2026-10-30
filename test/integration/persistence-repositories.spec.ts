import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Test } from '@nestjs/testing';
import { MikroORM } from '@mikro-orm/postgresql';
import { CLOCK, UNIT_OF_WORK, WALLET_REPOSITORY } from '../../src/application/ports/tokens';
import { TransientFailureError } from '../../src/application/errors/application.errors';
import { Clock } from '../../src/application/ports/clock.port';
import { UnitOfWork } from '../../src/application/ports/transaction-context';
import { WalletRepository } from '../../src/application/ports/wallet.repository';
import { LedgerDirection } from '../../src/domain/ledger/ledger-direction';
import { WalletLedgerEntry } from '../../src/domain/ledger/wallet-ledger-entry';
import { InboxMessage } from '../../src/domain/messaging/inbox-message';
import { OutboxMessage } from '../../src/domain/messaging/outbox-message';
import { Money } from '../../src/domain/money/money';
import { WagerTransactionKind } from '../../src/domain/wager-transaction/wager-transaction-kind';
import { WagerTransaction } from '../../src/domain/wager-transaction/wager-transaction';
import { Wallet } from '../../src/domain/wallet/wallet';
import { PersistenceModule } from '../../src/infrastructure/persistence/persistence.module';
import { MikroOrmClock } from '../../src/infrastructure/persistence/mikro-orm-clock';
import { MikroOrmEntityManagerResolver } from '../../src/infrastructure/persistence/mikro-orm-entity-manager-resolver';
import {
  TransactionContext,
  TransactionIsolation
} from '../../src/application/ports/transaction-context';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { MikroOrmInboxRepository } from '../../src/infrastructure/persistence/repositories/mikro-orm-inbox.repository';
import { MikroOrmLedgerEntryRepository } from '../../src/infrastructure/persistence/repositories/mikro-orm-ledger-entry.repository';
import { MikroOrmOutboxRepository } from '../../src/infrastructure/persistence/repositories/mikro-orm-outbox.repository';
import { MikroOrmWagerTransactionRepository } from '../../src/infrastructure/persistence/repositories/mikro-orm-wager-transaction.repository';
import { MikroOrmWalletRepository } from '../../src/infrastructure/persistence/repositories/mikro-orm-wallet.repository';
import { WagerTransactionProcessed } from '../../src/domain/events/wager-transaction-processed';
import { ensurePostgres, PostgresHarness, SuiteDatabase } from './support/postgres-harness';
import {
  captureError,
  insertTransaction,
  insertWallet,
  newId,
  VALID_HASH
} from './support/sql-fixtures';
import { WagerTransactionStatus } from '../../src/domain/wager-transaction/wager-transaction-status';

function brl(amount: string): Money {
  return Money.from({ amount, currency: 'BRL' });
}

describe('Persistence repositories', () => {
  let harness: PostgresHarness;
  let database: SuiteDatabase;
  let orm: MikroORM;
  let resolver: MikroOrmEntityManagerResolver;
  let unitOfWork: MikroOrmUnitOfWork;
  let clock: MikroOrmClock;
  let wallets: MikroOrmWalletRepository;
  let transactions: MikroOrmWagerTransactionRepository;
  let ledger: MikroOrmLedgerEntryRepository;
  let inbox: MikroOrmInboxRepository;
  let outbox: MikroOrmOutboxRepository;

  beforeAll(async () => {
    harness = await ensurePostgres();
    database = await harness.createSuiteDatabase('repositories');
    orm = database.orm;
    resolver = new MikroOrmEntityManagerResolver(orm);
    unitOfWork = new MikroOrmUnitOfWork(orm, resolver);
    clock = new MikroOrmClock(resolver);
    wallets = new MikroOrmWalletRepository(resolver);
    transactions = new MikroOrmWagerTransactionRepository(resolver);
    ledger = new MikroOrmLedgerEntryRepository(resolver);
    inbox = new MikroOrmInboxRepository(resolver);
    outbox = new MikroOrmOutboxRepository(resolver);
  }, 180000);

  afterAll(async () => {
    await database?.close();
    await harness?.stop();
  }, 180000);

  async function saveWalletWithOpening(
    ctx: TransactionContext,
    wallet: Wallet,
    suppliedOpening?: WagerTransaction
  ): Promise<WagerTransaction> {
    await wallets.save(wallet, ctx);
    const opening =
      suppliedOpening ??
      WagerTransaction.opening({
        id: newId(),
        walletId: wallet.id,
        playerId: wallet.playerId,
        money: wallet.balance,
        balanceAfter: wallet.balance,
        at: wallet.createdAt
      });
    await transactions.save(opening, ctx);
    await ledger.save(
      WalletLedgerEntry.create({
        id: newId(),
        walletId: wallet.id,
        transactionId: opening.id,
        direction: LedgerDirection.Credit,
        money: opening.money,
        balanceBefore: brl('0.00'),
        balanceAfter: wallet.balance,
        walletVersion: 1,
        createdAt: wallet.createdAt
      }),
      ctx
    );
    return opening;
  }

  async function saveMovement(
    ctx: TransactionContext,
    transaction: WagerTransaction,
    movement: { wallet: Wallet; entry: WalletLedgerEntry }
  ): Promise<void> {
    transaction.markProcessed(movement.wallet.balance, undefined, movement.wallet.updatedAt);
    await transactions.save(transaction, ctx);
    await wallets.save(movement.wallet, ctx);
    await ledger.save(movement.entry, ctx);
  }

  test('configuração do MikroORM fixa pool, timeouts e migrations', () => {
    expect(orm.config.get('pool')).toMatchObject({
      min: 0,
      max: 10,
      acquireTimeoutMillis: 5000,
      idleTimeoutMillis: 30000
    });
    expect(orm.config.get('driverOptions')).toMatchObject({
      connection: {
        connectionTimeoutMillis: 5000,
        idleTimeoutMillis: 30000
      }
    });
    expect(orm.config.get('migrations')).toMatchObject({
      transactional: true,
      allOrNothing: true
    });
  });

  test('UnitOfWork propaga contexto e aplica isolamento read-only', async () => {
    const snapshot = await unitOfWork.run(
      async (ctx) => {
        expect(unitOfWork.current()).toBe(ctx);
        const em = resolver.resolve(ctx);
        const rows = await em.execute<{ isolation: string; read_only: string }[]>(
          "select current_setting('transaction_isolation') as isolation, current_setting('transaction_read_only') as read_only"
        );
        return rows[0];
      },
      { isolation: TransactionIsolation.RepeatableRead, readOnly: true }
    );

    expect(snapshot?.isolation).toBe('repeatable read');
    expect(snapshot?.read_only).toBe('on');
    expect(unitOfWork.current()).toBeUndefined();
  });

  test('UnitOfWork aplica statement_timeout e lock_timeout por transação', async () => {
    const defaults = await unitOfWork.run(async (ctx) => {
      const em = resolver.resolve(ctx);
      const rows = await em.execute<{ statement_timeout: string; lock_timeout: string }[]>(
        "select current_setting('statement_timeout') as statement_timeout, current_setting('lock_timeout') as lock_timeout"
      );
      return rows[0];
    });
    expect(defaults?.statement_timeout).toMatch(/30s|30000ms/);
    expect(defaults?.lock_timeout).toMatch(/10s|10000ms/);

    const custom = await unitOfWork.run(
      async (ctx) => {
        const em = resolver.resolve(ctx);
        const rows = await em.execute<{ statement_timeout: string; lock_timeout: string }[]>(
          "select current_setting('statement_timeout') as statement_timeout, current_setting('lock_timeout') as lock_timeout"
        );
        return rows[0];
      },
      { statementTimeoutMs: 60000, lockTimeoutMs: 2000 }
    );
    expect(custom?.statement_timeout).toMatch(/60s|60000ms|1min/);
    expect(custom?.lock_timeout).toMatch(/2s|2000ms/);
  });

  test('wallet é salva, reidratada e buscada por player e moeda', async () => {
    const playerId = newId();
    const now = await clock.now();
    const wallet = Wallet.open({
      id: newId(),
      playerId,
      initialBalance: brl('100.00'),
      at: now
    });

    await unitOfWork.run(async (ctx) => {
      await saveWalletWithOpening(ctx, wallet);
    });

    const byId = await wallets.findById(wallet.id);

    expect(byId?.id).toBe(wallet.id);
    expect(byId?.balance.toString()).toBe('100.00');
  });

  test('save atualiza a wallet visível no mesmo EntityManager', async () => {
    const wallet = Wallet.open({
      id: newId(),
      playerId: newId(),
      initialBalance: brl('100.00'),
      at: await clock.now()
    });
    await unitOfWork.run((ctx) => saveWalletWithOpening(ctx, wallet));

    await unitOfWork.run(async (ctx) => {
      const current = await wallets.findByIdWithLock(wallet.id, ctx);
      expect(current?.version).toBe(1);
      const movementTransaction = WagerTransaction.create({
        id: newId(),
        providerId: 'provider-repository',
        externalTransactionId: 'repo-movement',
        idempotencyKey: 'repo-movement',
        payloadHash: VALID_HASH,
        walletId: wallet.id,
        playerId: wallet.playerId,
        roundId: 'round-1',
        gameId: 'game-1',
        kind: WagerTransactionKind.Bet,
        money: brl('10.00'),
        createdAt: await clock.now(ctx)
      });
      const movement = current!.debit({
        transactionId: movementTransaction.id,
        money: brl('10.00'),
        at: await clock.now(ctx)
      });
      await saveMovement(ctx, movementTransaction, movement);

      const reread = await wallets.findById(wallet.id, ctx);
      expect(reread?.version).toBe(2);
      expect(reread?.balance.toString()).toBe('90.00');
    });
  }, 60000);

  test('save rejeita escrita com versão obsoleta (CAS)', async () => {
    const wallet = Wallet.open({
      id: newId(),
      playerId: newId(),
      initialBalance: brl('100.00'),
      at: await clock.now()
    });
    await unitOfWork.run(async (ctx) => {
      await saveWalletWithOpening(ctx, wallet);
    });

    const stale = await wallets.findById(wallet.id);
    expect(stale?.version).toBe(1);

    await unitOfWork.run(async (ctx) => {
      const current = await wallets.findByIdWithLock(wallet.id, ctx);
      expect(current).toBeDefined();
      const movementTransaction = WagerTransaction.create({
        id: newId(),
        providerId: 'provider-repository',
        externalTransactionId: 'repo-cas-1',
        idempotencyKey: 'repo-cas-1',
        payloadHash: VALID_HASH,
        walletId: wallet.id,
        playerId: wallet.playerId,
        roundId: 'round-1',
        gameId: 'game-1',
        kind: WagerTransactionKind.Bet,
        money: brl('10.00'),
        createdAt: await clock.now(ctx)
      });
      const movement = current!.debit({
        transactionId: movementTransaction.id,
        money: brl('10.00'),
        at: await clock.now(ctx)
      });
      await saveMovement(ctx, movementTransaction, movement);
    });

    await unitOfWork.run(async (ctx) => {
      const current = await wallets.findById(wallet.id, ctx);
      expect(current?.version).toBe(2);
      await wallets.save(current!, ctx);
    });

    stale?.debit({ transactionId: newId(), money: brl('5.00'), at: new Date() });
    const error = await captureError(() => unitOfWork.run((ctx) => wallets.save(stale!, ctx)));
    expect(error).toBeInstanceOf(TransientFailureError);
    expect((error.cause as Error).message).toMatch(/version/i);

    const reloaded = await wallets.findById(wallet.id);
    expect(reloaded?.version).toBe(2);
    expect(reloaded?.balance.toString()).toBe('90.00');
  }, 60000);

  test('lock pessimista serializa a mesma wallet e respeita lock_timeout', async () => {
    const wallet = Wallet.open({
      id: newId(),
      playerId: newId(),
      initialBalance: brl('100.00'),
      at: await clock.now()
    });
    await unitOfWork.run(async (ctx) => {
      await saveWalletWithOpening(ctx, wallet);
    });

    let lockAcquired: () => void = () => undefined;
    const acquired = new Promise<void>((resolve) => {
      lockAcquired = resolve;
    });
    let releaseLock: () => void = () => undefined;
    const release = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    const first = unitOfWork.run(async (ctx) => {
      const locked = await wallets.findByIdWithLock(wallet.id, ctx);
      expect(locked?.id).toBe(wallet.id);
      lockAcquired();
      await release;
    });

    await acquired;
    const lockError = await captureError(() =>
      unitOfWork.run(
        async (ctx) => {
          await wallets.findByIdWithLock(wallet.id, ctx);
        },
        { lockTimeoutMs: 200 }
      )
    );
    expect(lockError).toBeInstanceOf(TransientFailureError);
    expect((lockError.cause as Error).message).toMatch(/lock timeout|55P03/i);

    releaseLock();
    await first;

    const afterRelease = await unitOfWork.run(async (ctx) =>
      wallets.findByIdWithLock(wallet.id, ctx)
    );
    expect(afterRelease?.id).toBe(wallet.id);
  }, 60000);

  test('ledger mantém cursor por wallet_version e soma assinada', async () => {
    const now = await clock.now();
    const wallet = Wallet.open({
      id: newId(),
      playerId: newId(),
      initialBalance: brl('100.00'),
      at: now
    });
    await unitOfWork.run(async (ctx) => {
      await saveWalletWithOpening(ctx, wallet);
    });

    await unitOfWork.run(async (ctx) => {
      const current = await wallets.findByIdWithLock(wallet.id, ctx);
      if (current === undefined) {
        throw new Error('Wallet not found');
      }

      const debitOne = WagerTransaction.create({
        id: newId(),
        providerId: 'provider-1',
        externalTransactionId: 'bet-1',
        idempotencyKey: 'key-1',
        payloadHash: VALID_HASH,
        walletId: wallet.id,
        playerId: wallet.playerId,
        roundId: 'round-1',
        gameId: 'game-1',
        kind: WagerTransactionKind.Bet,
        money: brl('20.00'),
        createdAt: now
      });
      const firstMovement = current.debit({
        transactionId: debitOne.id,
        money: brl('20.00'),
        at: now
      });
      debitOne.markProcessed(firstMovement.wallet.balance, undefined, now);
      await transactions.save(debitOne, ctx);
      await wallets.save(firstMovement.wallet, ctx);
      await ledger.save(firstMovement.entry, ctx);

      const debitTwo = WagerTransaction.create({
        id: newId(),
        providerId: 'provider-1',
        externalTransactionId: 'bet-2',
        idempotencyKey: 'key-2',
        payloadHash: VALID_HASH,
        walletId: wallet.id,
        playerId: wallet.playerId,
        roundId: 'round-1',
        gameId: 'game-1',
        kind: WagerTransactionKind.Bet,
        money: brl('30.00'),
        createdAt: now
      });
      const secondMovement = firstMovement.wallet.debit({
        transactionId: debitTwo.id,
        money: brl('30.00'),
        at: now
      });
      debitTwo.markProcessed(secondMovement.wallet.balance, undefined, now);
      await transactions.save(debitTwo, ctx);
      await wallets.save(secondMovement.wallet, ctx);
      await ledger.save(secondMovement.entry, ctx);

      const credit = WagerTransaction.create({
        id: newId(),
        providerId: 'provider-1',
        externalTransactionId: 'win-1',
        idempotencyKey: 'key-3',
        payloadHash: VALID_HASH,
        walletId: wallet.id,
        playerId: wallet.playerId,
        roundId: 'round-1',
        gameId: 'game-1',
        kind: WagerTransactionKind.Win,
        money: brl('10.00'),
        createdAt: now
      });
      const thirdMovement = secondMovement.wallet.credit({
        transactionId: credit.id,
        money: brl('10.00'),
        at: now
      });
      credit.markProcessed(thirdMovement.wallet.balance, undefined, now);
      await transactions.save(credit, ctx);
      await wallets.save(thirdMovement.wallet, ctx);
      await ledger.save(thirdMovement.entry, ctx);
    });

    const firstPage = await ledger.findByWalletIdCursor(wallet.id, undefined, 2);
    expect(firstPage.map((entry) => entry.walletVersion)).toEqual([4, 3]);

    const secondPage = await ledger.findByWalletIdCursor(wallet.id, 3, 2);
    expect(secondPage.map((entry) => entry.walletVersion)).toEqual([2, 1]);

    const ordered = await ledger.findByWalletIdOrdered(wallet.id);
    expect(ordered.map((entry) => entry.walletVersion)).toEqual([1, 2, 3, 4]);
    expect(ordered.map((entry) => entry.balanceBefore.toString())).toEqual([
      '0.00',
      '100.00',
      '80.00',
      '50.00'
    ]);
    expect(ordered.map((entry) => entry.balanceAfter.toString())).toEqual([
      '100.00',
      '80.00',
      '50.00',
      '60.00'
    ]);

    const sum = await ledger.sumByWalletId(wallet.id);
    expect(sum?.toString()).toBe('60.00');
    const stored = await wallets.findById(wallet.id);
    expect(stored?.balance.toString()).toBe('60.00');
    expect(stored?.version).toBe(4);
  }, 60000);

  test('wager transaction é buscada por id, idempotência, external, settlement e reversão', async () => {
    const now = await clock.now();
    const wallet = Wallet.open({
      id: newId(),
      playerId: newId(),
      initialBalance: brl('100.00'),
      at: now
    });
    const bet = WagerTransaction.create({
      id: newId(),
      providerId: 'provider-1',
      externalTransactionId: 'external-bet',
      idempotencyKey: 'idem-bet',
      payloadHash: VALID_HASH,
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Bet,
      money: brl('10.00'),
      createdAt: now
    });
    bet.markProcessed(brl('90.00'), undefined, now);

    const win = WagerTransaction.create({
      id: newId(),
      providerId: 'provider-1',
      externalTransactionId: 'external-win',
      idempotencyKey: 'idem-win',
      payloadHash: VALID_HASH,
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Win,
      money: brl('20.00'),
      referenceExternalTransactionId: 'external-bet',
      createdAt: now
    });
    win.markProcessed(brl('110.00'), bet.id, now);

    const rollback = WagerTransaction.create({
      id: newId(),
      providerId: 'provider-1',
      externalTransactionId: 'external-rollback',
      idempotencyKey: 'idem-rollback',
      payloadHash: VALID_HASH,
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Rollback,
      money: brl('10.00'),
      referenceExternalTransactionId: 'external-bet',
      createdAt: now
    });
    rollback.markProcessed(brl('100.00'), bet.id, now);

    const opening = WagerTransaction.opening({
      id: newId(),
      walletId: wallet.id,
      playerId: wallet.playerId,
      money: brl('100.00'),
      balanceAfter: brl('100.00'),
      at: now
    });

    await unitOfWork.run(async (ctx) => {
      await saveWalletWithOpening(ctx, wallet, opening);
      await transactions.save(bet, ctx);
      await transactions.save(win, ctx);
      await transactions.save(rollback, ctx);
    });

    const byId = await transactions.findById(bet.id);
    expect(byId?.externalTransactionId).toBe('external-bet');
    const byIdempotency = await transactions.findByProviderAndIdempotencyKey(
      'provider-1',
      'idem-bet'
    );
    expect(byIdempotency?.id).toBe(bet.id);
    const byExternal = await transactions.findByProviderAndExternalId('provider-1', 'external-bet');
    expect(byExternal?.id).toBe(bet.id);
    const settlement = await transactions.findSettlementByProviderAndReference(
      'provider-1',
      'external-bet'
    );
    expect(settlement?.id).toBe(win.id);
    const reversal = await transactions.findByReferenceTransactionId(bet.id);
    expect(reversal?.id).toBe(rollback.id);
    const openingRow = await transactions.findOpeningByWalletId(wallet.id);
    expect(openingRow?.id).toBe(opening.id);
    expect(openingRow?.providerId).toBeNull();
  }, 60000);

  test('pending references devidas são reivindicadas com SKIP LOCKED', async () => {
    const walletId = await insertWallet(orm.em.fork());
    const playerId = newId();
    const dueId = await insertTransaction(orm.em.fork(), {
      walletId,
      playerId,
      kind: WagerTransactionKind.Win,
      status: WagerTransactionStatus.PendingReference,
      nextReferenceAttemptAt: new Date(Date.now() - 1000),
      referenceExpiresAt: new Date(Date.now() + 3600_000)
    });
    await insertTransaction(orm.em.fork(), {
      walletId,
      playerId,
      kind: WagerTransactionKind.Win,
      status: WagerTransactionStatus.PendingReference,
      nextReferenceAttemptAt: new Date(Date.now() + 3600_000),
      referenceExpiresAt: new Date(Date.now() + 3600_000)
    });

    const due = await unitOfWork.run(async (ctx) =>
      transactions.claimDuePendingReferences(new Date(), 10, 30000, ctx)
    );
    expect(due.map((transaction) => transaction.id)).toContain(dueId);
    expect(due).toHaveLength(1);
  }, 60000);

  test('deferPendingReference usa o relógio fornecido', async () => {
    const walletId = await insertWallet(orm.em.fork());
    const playerId = newId();
    const transactionId = await insertTransaction(orm.em.fork(), {
      walletId,
      playerId,
      kind: WagerTransactionKind.Win,
      status: WagerTransactionStatus.PendingReference,
      referenceExternalTransactionId: 'missing-reference',
      nextReferenceAttemptAt: new Date(Date.now() - 1000),
      referenceExpiresAt: new Date(Date.now() + 3600_000),
      referenceLastAttemptAt: new Date('2000-01-01T00:00:00.000Z')
    });
    const nextAttemptAt = new Date('2026-01-01T00:01:00.000Z');
    const lastAttemptAt = new Date('2026-01-01T00:00:00.000Z');

    await transactions.deferPendingReference(transactionId, nextAttemptAt, lastAttemptAt);

    const rows = await orm.em.fork().execute<{ next: string; last: string }[]>(
      `select next_reference_attempt_at::text as next,
              reference_last_attempt_at::text as last
         from wager_transactions
        where id = ?`,
      [transactionId]
    );
    expect(new Date(String(rows[0]?.next)).toISOString()).toBe(nextAttemptAt.toISOString());
    expect(new Date(String(rows[0]?.last)).toISOString()).toBe(lastAttemptAt.toISOString());
  }, 60000);

  test('inbox insert-first preserva a primeira linha e detecta duplicata', async () => {
    const messageId = `msg-${newId()}`;
    const inbound = InboxMessage.receive({
      messageId,
      consumerName: 'wager-transactions',
      payloadHash: VALID_HASH,
      correlationId: 'corr-1'
    });
    const first = await inbox.insertIfAbsent(inbound);
    expect(first.inserted).toBe(true);

    const second = await inbox.insertIfAbsent(
      InboxMessage.receive({
        messageId,
        consumerName: 'wager-transactions',
        payloadHash: 'b'.repeat(64),
        correlationId: 'corr-2'
      })
    );
    expect(second.inserted).toBe(false);
    expect(second.existing?.payloadHash).toBe(VALID_HASH);
    expect(second.existing?.correlationId).toBe('corr-1');
  });

  test('outbox reivindica com lease, incrementa claim_count e agenda retry', async () => {
    const now = await clock.now();
    const opening = WagerTransaction.opening({
      id: newId(),
      walletId: newId(),
      playerId: newId(),
      money: brl('10.00'),
      balanceAfter: brl('10.00'),
      at: now
    });
    const event = WagerTransactionProcessed.from(opening, {
      correlationId: 'corr-outbox',
      occurredAt: now
    });
    const message = OutboxMessage.enqueue(event);

    await unitOfWork.run(async (ctx) => {
      await outbox.save(message, ctx);
    });

    const firstClaim = await unitOfWork.run(async (ctx) => outbox.claimDue(now, 10, 30000, ctx));
    expect(firstClaim).toHaveLength(1);
    expect(firstClaim[0]?.claimCount).toBe(1);
    expect(firstClaim[0]?.nextAttemptAt.getTime()).toBeGreaterThan(now.getTime());

    const secondClaim = await unitOfWork.run(async (ctx) => outbox.claimDue(now, 10, 30000, ctx));
    expect(secondClaim).toHaveLength(0);

    const retryAt = new Date(now.getTime() + 5000);
    await unitOfWork.run(async (ctx) => {
      await outbox.scheduleRetry(message.id, retryAt, 'publish failed', ctx);
    });
    const retried = await unitOfWork.run(async (ctx) =>
      outbox.claimDue(new Date(now.getTime() + 6000), 10, 30000, ctx)
    );
    expect(retried).toHaveLength(1);
    expect(retried[0]?.attempts).toBe(1);
    expect(retried[0]?.claimCount).toBe(2);

    await unitOfWork.run(async (ctx) => {
      await outbox.markDeadLettered(message.id, now, 'dead', ctx);
    });
    const afterDeadLetter = await unitOfWork.run(async (ctx) =>
      outbox.claimDue(new Date(now.getTime() + 120000), 10, 30000, ctx)
    );
    expect(afterDeadLetter).toHaveLength(0);
  }, 60000);

  test('outbox não ressuscita mensagem publicada ou dead-lettered', async () => {
    const now = await clock.now();
    const eventFor = (suffix: string) =>
      WagerTransactionProcessed.from(
        WagerTransaction.opening({
          id: newId(),
          walletId: newId(),
          playerId: newId(),
          money: brl('10.00'),
          balanceAfter: brl('10.00'),
          at: now
        }),
        { correlationId: `corr-${suffix}`, occurredAt: now }
      );
    const published = OutboxMessage.enqueue(eventFor('published'));
    const deadLettered = OutboxMessage.enqueue(eventFor('dead-lettered'));

    await unitOfWork.run(async (ctx) => {
      await outbox.save(published, ctx);
      await outbox.save(deadLettered, ctx);
    });

    await unitOfWork.run(async (ctx) => {
      await outbox.markPublished(published.id, now, ctx);
      await outbox.scheduleRetry(published.id, new Date(now.getTime() + 1000), 'late', ctx);
      await outbox.markDeadLettered(published.id, now, 'late', ctx);
    });

    await unitOfWork.run(async (ctx) => {
      await outbox.markDeadLettered(deadLettered.id, now, 'dead', ctx);
      await outbox.markPublished(deadLettered.id, now, ctx);
      await outbox.scheduleRetry(deadLettered.id, new Date(now.getTime() + 1000), 'late', ctx);
    });

    const rows = await orm.em
      .fork()
      .execute<{ id: string; published: boolean; dead: boolean; attempts: number }[]>(
        `select id,
              published_at is not null as published,
              dead_lettered_at is not null as dead,
              attempts
         from outbox_messages
        where id in (?, ?)`,
        [published.id, deadLettered.id]
      );
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(published.id)).toMatchObject({
      published: true,
      dead: false,
      attempts: 0
    });
    expect(byId.get(deadLettered.id)).toMatchObject({
      published: false,
      dead: true,
      attempts: 0
    });
  }, 60000);

  test('PersistenceModule expõe ports via NestJS', async () => {
    process.env.DATABASE_URL = database.url;
    const moduleRef = await Test.createTestingModule({ imports: [PersistenceModule] }).compile();
    try {
      await moduleRef.init();
      const resolvedUnitOfWork = moduleRef.get<UnitOfWork>(UNIT_OF_WORK);
      const resolvedClock = moduleRef.get<Clock>(CLOCK);
      const resolvedWallets = moduleRef.get<WalletRepository>(WALLET_REPOSITORY);
      const now = await resolvedClock.now();
      expect(now).toBeInstanceOf(Date);

      const wallet = Wallet.open({
        id: newId(),
        playerId: newId(),
        initialBalance: brl('0.00'),
        at: now
      });
      await resolvedUnitOfWork.run(async (ctx) => {
        await resolvedWallets.save(wallet, ctx);
      });
      const found = await resolvedUnitOfWork.run(async (ctx) =>
        resolvedWallets.findById(wallet.id, ctx)
      );
      expect(found?.id).toBe(wallet.id);
    } finally {
      await moduleRef.close();
    }
  }, 60000);
});
