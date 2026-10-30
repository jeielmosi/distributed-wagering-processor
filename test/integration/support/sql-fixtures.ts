import { EntityManager } from '@mikro-orm/postgresql';
import { WagerTransactionKind } from '../../../src/domain/wager-transaction/wager-transaction-kind';
import { WagerTransactionStatus } from '../../../src/domain/wager-transaction/wager-transaction-status';
import { FailureCode } from '../../../src/shared/errors/failure-code';
import { LedgerDirection } from '../../../src/domain/ledger/ledger-direction';

export const VALID_HASH = 'a'.repeat(64);

export function newId(): string {
  return Bun.randomUUIDv7();
}

export interface WalletFixture {
  id?: string;
  playerId?: string;
  currency?: string;
  balanceAmount?: string;
  version?: number;
  createdAt?: Date;
  updatedAt?: Date;
  /**
   * Creates the matching OPENING transaction and ledger entry. Defaults to
   * true whenever the fixture starts with a positive balance.
   */
  withOpening?: boolean;
}

export async function insertWallet(
  em: EntityManager,
  fixture: WalletFixture = {}
): Promise<string> {
  const id = fixture.id ?? newId();
  const playerId = fixture.playerId ?? newId();
  const currency = fixture.currency ?? 'BRL';
  const balance = fixture.balanceAmount ?? '100.00';
  const version = fixture.version ?? 1;
  const now = fixture.createdAt ?? new Date(Date.now() - 60_000);
  const withOpening = fixture.withOpening ?? (balance !== '0.00' && balance !== '0');

  await em.transactional(async (tx) => {
    await tx.execute(
      `insert into wallets (id, player_id, currency, balance_amount, version, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?)`,
      [id, playerId, currency, balance, version, now, fixture.updatedAt ?? now]
    );

    if (!withOpening || balance === '0.00' || balance === '0') {
      return;
    }

    const openingId = await insertTransaction(tx, {
      walletId: id,
      playerId,
      currency,
      kind: WagerTransactionKind.Opening,
      status: WagerTransactionStatus.Processed,
      amount: balance,
      balanceAfterAmount: balance,
      balanceAfterCurrency: currency,
      createdAt: now,
      processedAt: now,
      resolvedAt: now
    });

    await insertLedgerEntryRow(tx, {
      walletId: id,
      transactionId: openingId,
      walletVersion: 1,
      direction: LedgerDirection.Credit,
      amount: balance,
      currency,
      balanceBeforeAmount: '0.00',
      balanceAfterAmount: balance,
      createdAt: now
    });
  });

  return id;
}

export interface TransactionFixture {
  id?: string;
  walletId: string;
  playerId: string;
  currency?: string;
  providerId?: string | null;
  externalTransactionId?: string | null;
  idempotencyKey?: string;
  payloadHash?: string;
  roundId?: string | null;
  gameId?: string | null;
  kind?: string;
  amount?: string;
  balanceAfterAmount?: string | null;
  balanceAfterCurrency?: string | null;
  referenceExternalTransactionId?: string | null;
  referenceTransactionId?: string | null;
  status?: string;
  failureCode?: string | null;
  correlationId?: string | null;
  causationId?: string | null;
  createdAt?: Date;
  processedAt?: Date | null;
  resolvedAt?: Date | null;
  referenceAttempts?: number;
  nextReferenceAttemptAt?: Date | null;
  referenceExpiresAt?: Date | null;
  referenceLastAttemptAt?: Date | null;
}

export async function insertTransaction(
  em: EntityManager,
  fixture: TransactionFixture
): Promise<string> {
  const id = fixture.id ?? newId();
  const kind = fixture.kind ?? WagerTransactionKind.Bet;
  const status = fixture.status ?? WagerTransactionStatus.Pending;
  const currency = fixture.currency ?? 'BRL';
  const now = fixture.createdAt ?? new Date(Date.now() - 60_000);
  const isOpening = kind === WagerTransactionKind.Opening;
  const isTerminal =
    status === WagerTransactionStatus.Processed ||
    status === WagerTransactionStatus.Rejected ||
    status === WagerTransactionStatus.Failed;
  const balanceAfterAmount =
    fixture.balanceAfterAmount !== undefined
      ? fixture.balanceAfterAmount
      : status === WagerTransactionStatus.Processed
        ? isOpening
          ? (fixture.amount ?? '10.00')
          : '90.00'
        : null;
  const balanceAfterCurrency =
    fixture.balanceAfterCurrency !== undefined
      ? fixture.balanceAfterCurrency
      : status === WagerTransactionStatus.Processed
        ? currency
        : null;
  const processedAt =
    fixture.processedAt !== undefined
      ? fixture.processedAt
      : status === WagerTransactionStatus.Processed
        ? now
        : null;
  const resolvedAt =
    fixture.resolvedAt !== undefined ? fixture.resolvedAt : isTerminal ? now : null;
  const failureCode =
    fixture.failureCode !== undefined
      ? fixture.failureCode
      : status === WagerTransactionStatus.Rejected || status === WagerTransactionStatus.Failed
        ? FailureCode.InvalidPayload
        : null;
  const nextReferenceAttemptAt =
    fixture.nextReferenceAttemptAt !== undefined
      ? fixture.nextReferenceAttemptAt
      : status === WagerTransactionStatus.PendingReference
        ? now
        : null;
  const referenceExpiresAt =
    fixture.referenceExpiresAt !== undefined
      ? fixture.referenceExpiresAt
      : status === WagerTransactionStatus.PendingReference
        ? new Date(now.getTime() + 3600_000)
        : null;

  await em.execute(
    `insert into wager_transactions (
       id, provider_id, external_transaction_id, idempotency_key, payload_hash,
       wallet_id, player_id, round_id, game_id, kind, amount, currency,
       balance_after_amount, balance_after_currency, reference_external_transaction_id,
       reference_transaction_id, status, failure_code, correlation_id, causation_id,
       created_at, updated_at, processed_at, resolved_at, reference_attempts,
       next_reference_attempt_at, reference_expires_at, reference_last_attempt_at
     ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      isOpening ? (fixture.providerId ?? null) : (fixture.providerId ?? 'provider-1'),
      isOpening
        ? (fixture.externalTransactionId ?? null)
        : (fixture.externalTransactionId ?? `ext-${id}`),
      fixture.idempotencyKey ?? (isOpening ? `internal:opening:${fixture.walletId}` : `key-${id}`),
      fixture.payloadHash ?? VALID_HASH,
      fixture.walletId,
      fixture.playerId,
      isOpening ? (fixture.roundId ?? null) : (fixture.roundId ?? 'round-1'),
      isOpening ? (fixture.gameId ?? null) : (fixture.gameId ?? 'game-1'),
      kind,
      fixture.amount ?? '10.00',
      currency,
      balanceAfterAmount,
      balanceAfterCurrency,
      fixture.referenceExternalTransactionId !== undefined
        ? fixture.referenceExternalTransactionId
        : kind === WagerTransactionKind.Refund || kind === WagerTransactionKind.Rollback
          ? `bet-ref-${id}`
          : status === WagerTransactionStatus.PendingReference
            ? `missing-ref-${id}`
            : null,
      fixture.referenceTransactionId ?? null,
      status,
      failureCode,
      fixture.correlationId ?? null,
      fixture.causationId ?? null,
      now,
      fixture.createdAt ?? now,
      processedAt,
      resolvedAt,
      fixture.referenceAttempts ?? 0,
      nextReferenceAttemptAt,
      referenceExpiresAt,
      fixture.referenceLastAttemptAt ?? null
    ]
  );
  return id;
}

export interface LedgerFixture {
  id?: string;
  walletId: string;
  transactionId: string;
  walletVersion?: number;
  direction?: string;
  amount?: string;
  currency?: string;
  balanceBeforeAmount?: string;
  balanceAfterAmount?: string;
  createdAt?: Date;
}

async function insertLedgerEntryRow(em: EntityManager, fixture: LedgerFixture): Promise<string> {
  const id = fixture.id ?? newId();
  await em.execute(
    `insert into wallet_ledger_entries (
       id, wallet_id, transaction_id, wallet_version, direction, amount, currency,
       balance_before_amount, balance_after_amount, created_at
     ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      fixture.walletId,
      fixture.transactionId,
      fixture.walletVersion ?? 2,
      fixture.direction ?? LedgerDirection.Debit,
      fixture.amount ?? '10.00',
      fixture.currency ?? 'BRL',
      fixture.balanceBeforeAmount ?? '100.00',
      fixture.balanceAfterAmount ?? '90.00',
      fixture.createdAt ?? new Date()
    ]
  );
  return id;
}

export async function insertLedgerEntry(
  em: EntityManager,
  fixture: LedgerFixture
): Promise<string> {
  const walletVersion = fixture.walletVersion ?? 2;
  const balanceAfterAmount = fixture.balanceAfterAmount ?? '90.00';

  return em.transactional(async (tx) => {
    const id = await insertLedgerEntryRow(tx, fixture);
    await tx.execute('update wallets set balance_amount = ?, version = ? where id = ?', [
      balanceAfterAmount,
      walletVersion,
      fixture.walletId
    ]);
    return id;
  });
}

export interface InboxFixture {
  messageId?: string;
  consumerName?: string;
  payloadHash?: string;
  correlationId?: string | null;
  receivedAt?: Date;
  processedAt?: Date | null;
}

export async function insertInboxMessage(
  em: EntityManager,
  fixture: InboxFixture = {}
): Promise<{ messageId: string; consumerName: string }> {
  const messageId = fixture.messageId ?? `msg-${newId()}`;
  const consumerName = fixture.consumerName ?? 'wager-transactions';
  const receivedAt = fixture.receivedAt ?? new Date();
  await em.execute(
    `insert into inbox_messages
       (message_id, consumer_name, payload_hash, correlation_id, received_at, processed_at)
     values (?, ?, ?, ?, ?, ?)`,
    [
      messageId,
      consumerName,
      fixture.payloadHash ?? VALID_HASH,
      fixture.correlationId ?? null,
      receivedAt,
      fixture.processedAt ?? null
    ]
  );
  return { messageId, consumerName };
}

export interface OutboxFixture {
  id?: string;
  aggregateId?: string;
  eventType?: string;
  payload?: Record<string, unknown>;
  correlationId?: string | null;
  occurredAt?: Date;
  attempts?: number;
  claimCount?: number;
  nextAttemptAt?: Date;
  publishedAt?: Date | null;
  deadLetteredAt?: Date | null;
  lastError?: string | null;
}

export async function insertOutboxMessage(
  em: EntityManager,
  fixture: OutboxFixture = {}
): Promise<string> {
  const id = fixture.id ?? newId();
  const occurredAt = fixture.occurredAt ?? new Date();
  const nextAttemptAt = fixture.nextAttemptAt === undefined ? occurredAt : fixture.nextAttemptAt;
  await em.execute(
    `insert into outbox_messages (
       id, aggregate_id, event_type, payload, correlation_id, occurred_at,
       attempts, claim_count, next_attempt_at, published_at, dead_lettered_at, last_error
     ) values (?, ?, ?, ?::jsonb, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      fixture.aggregateId ?? newId(),
      fixture.eventType ?? 'WagerTransactionProcessed',
      JSON.stringify(fixture.payload ?? { eventId: id }),
      fixture.correlationId ?? null,
      occurredAt,
      fixture.attempts ?? 0,
      fixture.claimCount ?? 0,
      nextAttemptAt,
      fixture.publishedAt ?? null,
      fixture.deadLetteredAt ?? null,
      fixture.lastError ?? null
    ]
  );
  return id;
}

export async function captureError(work: () => Promise<unknown>): Promise<Error> {
  try {
    await work();
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error('Expected the operation to fail');
}
