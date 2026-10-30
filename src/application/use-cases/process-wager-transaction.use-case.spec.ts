import { describe, expect, test } from 'bun:test';
import { ProcessWagerTransactionUseCase } from './process-wager-transaction.use-case';
import { ProcessWagerTransactionCommand } from './process-wager-transaction.types';
import { IdempotencyService } from '../services/idempotency.service';
import { ReferenceResolverService } from '../services/reference-resolver.service';
import { TransactionApplicationService } from '../services/transaction-application.service';
import type { WalletRepository } from '../ports/wallet.repository';
import type { WagerTransactionRepository } from '../ports/wager-transaction.repository';
import type { LedgerEntryRepository } from '../ports/ledger-entry.repository';
import type { OutboxRepository } from '../ports/outbox.repository';
import type { Clock } from '../ports/clock.port';
import type { LoggerPort, MetricsPort } from '../ports/observability.port';
import type { TransactionContext, UnitOfWork } from '../ports/transaction-context';
import { Wallet } from '../../domain/wallet/wallet';
import { Money } from '../../domain/money/money';
import type { WagerTransaction } from '../../domain/wager-transaction/wager-transaction';
import type { WalletLedgerEntry } from '../../domain/ledger/wallet-ledger-entry';
import type { OutboxMessage } from '../../domain/messaging/outbox-message';
import { WagerTransactionKind } from '../../domain/wager-transaction/wager-transaction-kind';
import { WagerTransactionStatus } from '../../domain/wager-transaction/wager-transaction-status';
import { FailureCode } from '../../shared/errors/failure-code';
import {
  IdempotencyPayloadMismatchError,
  WalletNotFoundError,
  WalletPlayerMismatchError
} from '../errors/application.errors';
import { newUuidV7 } from '../../shared/id/uuid';

const NOW = new Date('2026-10-26T12:00:00.000Z');
const WALLET_ID = '0192f291-27dd-7d3f-8071-5f8685deef37';
const PLAYER_ID = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';

const logger: LoggerPort = {
  info: () => {},
  warn: () => {},
  error: () => {}
};

const metrics: MetricsPort = {
  transactionPersisted: () => {},
  observeProcessing: () => {},
  idempotencyHit: () => {},
  reconciliationDivergence: () => {},
  uncorrelatedWin: () => {},
  preLineFailure: () => {}
};

class FakeUnitOfWork implements UnitOfWork {
  private context: TransactionContext | undefined;
  runs = 0;

  async run<T>(work: (ctx: TransactionContext) => Promise<T>): Promise<T> {
    const ctx: TransactionContext = { id: `ctx-${this.runs + 1}` };
    this.context = ctx;
    this.runs += 1;
    try {
      return await work(ctx);
    } finally {
      this.context = undefined;
    }
  }

  current(): TransactionContext | undefined {
    return this.context;
  }
}

class FakeClock implements Clock {
  async now(): Promise<Date> {
    return NOW;
  }
}

class FakeWalletRepository implements WalletRepository {
  locked = false;

  constructor(public wallet: Wallet | undefined) {}

  async findById(id: string): Promise<Wallet | undefined> {
    return this.wallet?.id === id ? this.wallet : undefined;
  }

  async findByIdWithLock(id: string): Promise<Wallet | undefined> {
    this.locked = true;
    return this.findById(id);
  }

  async save(wallet: Wallet): Promise<void> {
    this.wallet = wallet;
  }
}

class FakeTransactionRepository implements WagerTransactionRepository {
  readonly items: WagerTransaction[] = [];
  throwOnNextSave = false;
  onIdempotencyLookup?: () => void;

  async findById(id: string): Promise<WagerTransaction | undefined> {
    return this.items.find((item) => item.id === id);
  }

  async findByProviderAndIdempotencyKey(
    providerId: string,
    idempotencyKey: string
  ): Promise<WagerTransaction | undefined> {
    this.onIdempotencyLookup?.();
    return this.items.find(
      (item) => item.providerId === providerId && item.idempotencyKey === idempotencyKey
    );
  }

  async findOpeningByWalletId(): Promise<WagerTransaction | undefined> {
    return undefined;
  }

  async findByProviderAndExternalId(): Promise<WagerTransaction | undefined> {
    return undefined;
  }

  async findSettlementByProviderAndReference(): Promise<WagerTransaction | undefined> {
    return undefined;
  }

  async findByReferenceTransactionId(): Promise<WagerTransaction | undefined> {
    return undefined;
  }

  async claimDuePendingReferences(): Promise<WagerTransaction[]> {
    return [];
  }

  async deferPendingReference(): Promise<void> {
    return undefined;
  }

  async save(transaction: WagerTransaction): Promise<void> {
    if (this.throwOnNextSave) {
      this.throwOnNextSave = false;
      throw new Error('unexpected persistence failure');
    }
    const index = this.items.findIndex((item) => item.id === transaction.id);
    if (index === -1) {
      this.items.push(transaction);
    } else {
      this.items[index] = transaction;
    }
  }
}

class FakeLedgerRepository implements LedgerEntryRepository {
  readonly items: WalletLedgerEntry[] = [];

  async save(entry: WalletLedgerEntry): Promise<void> {
    this.items.push(entry);
  }

  async findByWalletIdCursor(): Promise<WalletLedgerEntry[]> {
    return [];
  }

  async findByWalletIdOrdered(): Promise<WalletLedgerEntry[]> {
    return this.items;
  }

  async sumByWalletId(): Promise<Money | undefined> {
    return undefined;
  }
}

class FakeOutboxRepository implements OutboxRepository {
  readonly items: OutboxMessage[] = [];

  async save(outbox: OutboxMessage): Promise<void> {
    this.items.push(outbox);
  }

  async claimDue(): Promise<OutboxMessage[]> {
    return [];
  }

  async markPublished(): Promise<void> {
    return undefined;
  }

  async scheduleRetry(): Promise<void> {
    return undefined;
  }

  async markDeadLettered(): Promise<void> {
    return undefined;
  }

  async countPending(): Promise<number> {
    return this.items.filter((item) => item.isPending()).length;
  }

  async countDeadLettered(): Promise<number> {
    return this.items.filter((item) => !item.isPending()).length;
  }
}

interface Fixture {
  useCase: ProcessWagerTransactionUseCase;
  uow: FakeUnitOfWork;
  wallets: FakeWalletRepository;
  transactions: FakeTransactionRepository;
  ledger: FakeLedgerRepository;
  outbox: FakeOutboxRepository;
}

function fixture(initialBalance = '100.00'): Fixture {
  const wallet = Wallet.open({
    id: WALLET_ID,
    playerId: PLAYER_ID,
    initialBalance: Money.from({ amount: initialBalance, currency: 'BRL' }),
    at: NOW
  });
  const wallets = new FakeWalletRepository(wallet);
  const transactions = new FakeTransactionRepository();
  const ledger = new FakeLedgerRepository();
  const outbox = new FakeOutboxRepository();
  const uow = new FakeUnitOfWork();
  const useCase = new ProcessWagerTransactionUseCase(
    uow,
    new FakeClock(),
    metrics,
    wallets,
    new TransactionApplicationService(logger, metrics, transactions, ledger, wallets, outbox),
    new IdempotencyService(transactions),
    new ReferenceResolverService(transactions)
  );
  return { useCase, uow, wallets, transactions, ledger, outbox };
}

function command(
  overrides: Partial<ProcessWagerTransactionCommand> = {}
): ProcessWagerTransactionCommand {
  return {
    providerId: 'provider-a',
    externalTransactionId: 'external-1',
    idempotencyKey: 'key-1',
    playerId: PLAYER_ID,
    walletId: WALLET_ID,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: WagerTransactionKind.Bet,
    money: { amount: '25.00', currency: 'BRL' },
    correlationId: 'corr-1',
    ...overrides
  };
}

describe('ProcessWagerTransactionUseCase', () => {
  test('processa BET, debita a wallet e enfileira eventos', async () => {
    const { useCase, wallets, transactions, ledger, outbox } = fixture('100.00');

    const result = await useCase.execute(command());

    expect(result).toMatchObject({
      status: WagerTransactionStatus.Processed,
      balance: { amount: '75.00', currency: 'BRL' },
      idempotentReplay: false
    });
    expect(wallets.wallet?.balance.toString()).toBe('75.00');
    expect(wallets.wallet?.version).toBe(2);
    expect(transactions.items).toHaveLength(1);
    expect(ledger.items).toHaveLength(1);
    expect(ledger.items[0]?.walletVersion).toBe(2);
    expect(outbox.items.map((item) => item.eventType).sort()).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged'
    ]);
  });

  test('replay com a mesma key e payload devolve o saldo histórico', async () => {
    const { useCase, ledger, transactions } = fixture('100.00');
    const first = await useCase.execute(command());
    const second = await useCase.execute(command());

    expect(second).toMatchObject({
      transactionId: first.transactionId,
      status: WagerTransactionStatus.Processed,
      balance: first.balance,
      idempotentReplay: true
    });
    expect(ledger.items).toHaveLength(1);
    expect(transactions.items).toHaveLength(1);
  });

  test('mesma key com payload divergente falha com IDEMPOTENCY_PAYLOAD_MISMATCH', async () => {
    const { useCase } = fixture('100.00');
    await useCase.execute(command());

    await expect(
      useCase.execute(command({ money: { amount: '30.00', currency: 'BRL' } }))
    ).rejects.toThrow(IdempotencyPayloadMismatchError);
  });

  test('BET sem saldo é persistida como REJECTED com INSUFFICIENT_FUNDS', async () => {
    const { useCase, transactions, ledger, outbox } = fixture('10.00');

    const result = await useCase.execute(command({ money: { amount: '25.00', currency: 'BRL' } }));

    expect(result).toMatchObject({
      status: WagerTransactionStatus.Rejected,
      failureCode: FailureCode.InsufficientFunds,
      idempotentReplay: false
    });
    expect(ledger.items).toHaveLength(0);
    expect(transactions.items[0]?.status).toBe(WagerTransactionStatus.Rejected);
    expect(outbox.items.map((item) => item.eventType)).toEqual(['WagerTransactionRejected']);
  });

  test('referência ausente persiste PENDING_REFERENCE com backoff e TTL', async () => {
    const { useCase, transactions, outbox } = fixture('100.00');

    const result = await useCase.execute(
      command({
        kind: WagerTransactionKind.Win,
        money: { amount: '10.00', currency: 'BRL' },
        referenceExternalTransactionId: `missing-${newUuidV7()}`
      })
    );

    expect(result.status).toBe(WagerTransactionStatus.PendingReference);
    const stored = transactions.items[0];
    expect(stored?.nextReferenceAttemptAt?.toISOString()).toBe(
      new Date(NOW.getTime() + 5000).toISOString()
    );
    expect(stored?.referenceExpiresAt?.toISOString()).toBe(
      new Date(NOW.getTime() + 3600_000).toISOString()
    );
    expect(outbox.items.map((item) => item.eventType)).toEqual([
      'WagerTransactionPendingReference'
    ]);
  });

  test('WIN sem referência é rejeitado sem creditar', async () => {
    const { useCase, wallets } = fixture('100.00');

    const result = await useCase.execute(
      command({
        kind: WagerTransactionKind.Win,
        externalTransactionId: 'win-1',
        money: { amount: '10.00', currency: 'BRL' }
      })
    );

    expect(result).toMatchObject({
      status: WagerTransactionStatus.Rejected,
      failureCode: FailureCode.ReferenceRequired
    });
    expect(result.balance).toBeUndefined();
    expect(wallets.wallet?.balance.toString()).toBe('100.00');
  });

  test('erro inesperado pós-linha grava FAILED sem evento de integração', async () => {
    const { useCase, transactions, outbox } = fixture('100.00');
    transactions.throwOnNextSave = true;

    const result = await useCase.execute(command());

    expect(result).toMatchObject({
      status: WagerTransactionStatus.Failed,
      failureCode: FailureCode.PermanentInfraFailure,
      idempotentReplay: false
    });
    expect(transactions.items).toHaveLength(1);
    expect(transactions.items[0]?.status).toBe(WagerTransactionStatus.Failed);
    expect(outbox.items).toHaveLength(0);
  });

  test('ownership divergente falha antes de criar a transação', async () => {
    const { useCase, transactions } = fixture('100.00');

    await expect(useCase.execute(command({ playerId: newUuidV7() }))).rejects.toThrow(
      WalletPlayerMismatchError
    );
    expect(transactions.items).toHaveLength(0);
  });

  test('recheck de idempotência ocorre depois do lock da wallet', async () => {
    const { useCase, wallets, transactions } = fixture('100.00');
    let recheckedAfterLock = false;
    transactions.onIdempotencyLookup = () => {
      if (wallets.locked) {
        recheckedAfterLock = true;
      }
    };

    await useCase.execute(command());

    expect(recheckedAfterLock).toBe(true);
  });

  test('execute com contexto explícito participa da transação do chamador', async () => {
    const { useCase, uow } = fixture('100.00');

    const result = await uow.run((ctx) => useCase.execute(command(), ctx));

    expect(result.status).toBe(WagerTransactionStatus.Processed);
    expect(uow.runs).toBe(1);
  });

  test('erro inesperado com contexto explícito propaga para o chamador', async () => {
    const { useCase, uow, transactions } = fixture('100.00');
    transactions.throwOnNextSave = true;

    await expect(uow.run((ctx) => useCase.execute(command(), ctx))).rejects.toThrow(
      'unexpected persistence failure'
    );
  });

  test('wallet inexistente falha com WALLET_NOT_FOUND (422)', async () => {
    const { useCase, wallets } = fixture('100.00');
    wallets.wallet = undefined;

    try {
      await useCase.execute(command());
      throw new Error('expected execute to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(WalletNotFoundError);
      expect((error as WalletNotFoundError).httpStatus).toBe(422);
      expect((error as WalletNotFoundError).failureCode).toBe(FailureCode.WalletNotFound);
    }
  });
});
