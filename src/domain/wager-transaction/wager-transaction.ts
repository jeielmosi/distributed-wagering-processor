import { canonicalJson, sha256Hex } from '../../shared/hash/canonical-hash';
import { FailureCode } from '../../shared/errors/failure-code';
import { ZeroMovementError } from '../../shared/errors/zero-movement-error';
import { LedgerDirection } from '../ledger/ledger-direction';
import { Money } from '../money/money';
import { WagerTransactionKind } from './wager-transaction-kind';
import { WagerTransactionStatus } from './wager-transaction-status';
import {
  InvalidTransactionStateError,
  InvalidWagerTransactionError
} from './wager-transaction.errors';

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  correlationId?: string;
  causationId?: string;
  createdAt?: Date;
}

export interface OpeningWagerTransactionProps {
  id: string;
  walletId: string;
  playerId: string;
  money: Money;
  balanceAfter: Money;
  payloadHash?: string;
  correlationId?: string;
  causationId?: string;
  at?: Date;
}

export interface PendingReferenceSchedule {
  nextReferenceAttemptAt: Date;
  referenceExpiresAt: Date;
}

export interface WagerTransactionState {
  id: string;
  providerId: string | null;
  externalTransactionId: string | null;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string | null;
  gameId: string | null;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
  status: WagerTransactionStatus;
  failureCode?: FailureCode;
  balanceAfter?: Money;
  correlationId?: string;
  causationId?: string;
  referenceAttempts?: number;
  nextReferenceAttemptAt?: Date;
  referenceExpiresAt?: Date;
  referenceLastAttemptAt?: Date;
  createdAt: Date;
  processedAt?: Date;
  resolvedAt?: Date;
  updatedAt?: Date;
}

const PROVIDER_KINDS = new Set<WagerTransactionKind>([
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback
]);

const PAYLOAD_HASH_PATTERN = /^[0-9a-f]{64}$/;

function assertNonEmpty(value: string, field: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new InvalidWagerTransactionError(`${field} must be a non-empty string`);
  }
  if (value.length > 255) {
    throw new InvalidWagerTransactionError(`${field} must be at most 255 characters`);
  }
}

function assertTerminalGuard(transaction: WagerTransaction): void {
  if (transaction.isTerminal()) {
    throw new InvalidTransactionStateError(
      `Cannot transition a transaction in terminal state ${transaction.status}`
    );
  }
}

export class WagerTransaction {
  readonly id: string;
  readonly providerId: string | null;
  readonly externalTransactionId: string | null;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string | null;
  readonly gameId: string | null;
  readonly kind: WagerTransactionKind;
  readonly money: Money;
  readonly referenceExternalTransactionId?: string;
  readonly correlationId?: string;
  readonly causationId?: string;
  readonly createdAt: Date;
  private _status: WagerTransactionStatus;
  private _referenceTransactionId?: string;
  private _failureCode?: FailureCode;
  private _balanceAfter?: Money;
  private _processedAt?: Date;
  private _resolvedAt?: Date;
  private _updatedAt: Date;
  private _referenceAttempts: number;
  private _nextReferenceAttemptAt?: Date;
  private _referenceExpiresAt?: Date;
  private _referenceLastAttemptAt?: Date;

  private constructor(state: WagerTransactionState) {
    this.id = state.id;
    this.providerId = state.providerId;
    this.externalTransactionId = state.externalTransactionId;
    this.idempotencyKey = state.idempotencyKey;
    this.payloadHash = state.payloadHash;
    this.walletId = state.walletId;
    this.playerId = state.playerId;
    this.roundId = state.roundId;
    this.gameId = state.gameId;
    this.kind = state.kind;
    this.money = state.money;
    this.referenceExternalTransactionId = state.referenceExternalTransactionId;
    this.correlationId = state.correlationId;
    this.causationId = state.causationId;
    this.createdAt = state.createdAt;
    this._status = state.status;
    this._referenceTransactionId = state.referenceTransactionId;
    this._failureCode = state.failureCode;
    this._balanceAfter = state.balanceAfter;
    this._processedAt = state.processedAt;
    this._resolvedAt = state.resolvedAt;
    this._updatedAt = state.updatedAt ?? state.createdAt;
    this._referenceAttempts = state.referenceAttempts ?? 0;
    this._nextReferenceAttemptAt = state.nextReferenceAttemptAt;
    this._referenceExpiresAt = state.referenceExpiresAt;
    this._referenceLastAttemptAt = state.referenceLastAttemptAt;
  }

  static create(props: CreateWagerTransactionProps): WagerTransaction {
    assertNonEmpty(props.id, 'id');
    assertNonEmpty(props.providerId, 'providerId');
    assertNonEmpty(props.externalTransactionId, 'externalTransactionId');
    assertNonEmpty(props.idempotencyKey, 'idempotencyKey');
    assertNonEmpty(props.payloadHash, 'payloadHash');
    assertNonEmpty(props.walletId, 'walletId');
    assertNonEmpty(props.playerId, 'playerId');
    assertNonEmpty(props.roundId, 'roundId');
    assertNonEmpty(props.gameId, 'gameId');

    if (!PAYLOAD_HASH_PATTERN.test(props.payloadHash)) {
      throw new InvalidWagerTransactionError(
        'payloadHash must be a 64-character hexadecimal string'
      );
    }
    const reference = props.referenceExternalTransactionId;
    if (reference !== undefined) {
      assertNonEmpty(reference, 'referenceExternalTransactionId');
    }
    if (props.correlationId !== undefined) {
      assertNonEmpty(props.correlationId, 'correlationId');
    }
    if (props.causationId !== undefined) {
      assertNonEmpty(props.causationId, 'causationId');
    }
    if (props.kind === WagerTransactionKind.Opening) {
      if (reference !== undefined) {
        throw new InvalidWagerTransactionError('OPENING must not carry a reference');
      }
      throw new InvalidWagerTransactionError(
        'OPENING cannot be submitted by API or queue',
        FailureCode.OpeningNotAllowed
      );
    }
    if (!PROVIDER_KINDS.has(props.kind)) {
      throw new InvalidWagerTransactionError(`Unsupported transaction kind: ${String(props.kind)}`);
    }
    if (props.money.isNegative()) {
      throw new InvalidWagerTransactionError('Transaction money must not be negative');
    }
    if (props.money.isZero()) {
      throw new ZeroMovementError();
    }

    if (
      (props.kind === WagerTransactionKind.Refund ||
        props.kind === WagerTransactionKind.Rollback) &&
      reference === undefined
    ) {
      throw new InvalidWagerTransactionError(
        `${props.kind} requires referenceExternalTransactionId`
      );
    }
    if (props.kind === WagerTransactionKind.Bet && reference !== undefined) {
      throw new InvalidWagerTransactionError('BET must not carry referenceExternalTransactionId');
    }
    if (reference !== undefined && reference === props.externalTransactionId) {
      throw new InvalidWagerTransactionError('Self-reference is not allowed');
    }

    const createdAt = props.createdAt ?? new Date();
    return new WagerTransaction({
      id: props.id,
      providerId: props.providerId,
      externalTransactionId: props.externalTransactionId,
      idempotencyKey: props.idempotencyKey,
      payloadHash: props.payloadHash,
      walletId: props.walletId,
      playerId: props.playerId,
      roundId: props.roundId,
      gameId: props.gameId,
      kind: props.kind,
      money: props.money,
      referenceExternalTransactionId: reference,
      correlationId: props.correlationId,
      causationId: props.causationId,
      status: WagerTransactionStatus.Pending,
      createdAt,
      updatedAt: createdAt
    });
  }

  static opening(props: OpeningWagerTransactionProps): WagerTransaction {
    assertNonEmpty(props.id, 'id');
    assertNonEmpty(props.walletId, 'walletId');
    assertNonEmpty(props.playerId, 'playerId');
    if (props.money.isNegative() || props.balanceAfter.isNegative()) {
      throw new InvalidWagerTransactionError('OPENING amounts must not be negative');
    }
    if (!props.money.isPositive()) {
      throw new InvalidWagerTransactionError('OPENING requires a positive initial balance');
    }
    if (!props.money.equals(props.balanceAfter)) {
      throw new InvalidWagerTransactionError('OPENING money must equal balanceAfter');
    }
    const at = props.at ?? new Date();
    const payloadHash =
      props.payloadHash ??
      sha256Hex(
        canonicalJson({
          walletId: props.walletId,
          playerId: props.playerId,
          kind: WagerTransactionKind.Opening,
          money: props.money.toJSON()
        })
      );
    if (!PAYLOAD_HASH_PATTERN.test(payloadHash)) {
      throw new InvalidWagerTransactionError(
        'payloadHash must be a 64-character hexadecimal string'
      );
    }
    if (props.correlationId !== undefined) {
      assertNonEmpty(props.correlationId, 'correlationId');
    }
    if (props.causationId !== undefined) {
      assertNonEmpty(props.causationId, 'causationId');
    }
    return new WagerTransaction({
      id: props.id,
      providerId: null,
      externalTransactionId: null,
      idempotencyKey: `internal:opening:${props.walletId}`,
      payloadHash,
      walletId: props.walletId,
      playerId: props.playerId,
      roundId: null,
      gameId: null,
      kind: WagerTransactionKind.Opening,
      money: props.money,
      correlationId: props.correlationId,
      causationId: props.causationId,
      status: WagerTransactionStatus.Processed,
      balanceAfter: props.balanceAfter,
      createdAt: at,
      processedAt: at,
      resolvedAt: at,
      updatedAt: at
    });
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(state);
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get balanceAfter(): Money | undefined {
    return this._balanceAfter;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  get resolvedAt(): Date | undefined {
    return this._resolvedAt;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  get referenceAttempts(): number {
    return this._referenceAttempts;
  }

  get nextReferenceAttemptAt(): Date | undefined {
    return this._nextReferenceAttemptAt;
  }

  get referenceExpiresAt(): Date | undefined {
    return this._referenceExpiresAt;
  }

  get referenceLastAttemptAt(): Date | undefined {
    return this._referenceLastAttemptAt;
  }

  markProcessed(balanceAfter: Money, referenceTransactionId?: string, at?: Date): void {
    assertTerminalGuard(this);
    if (balanceAfter.isNegative()) {
      throw new InvalidWagerTransactionError('balanceAfter must not be negative');
    }
    if (balanceAfter.currency !== this.money.currency) {
      throw new InvalidWagerTransactionError(
        'balanceAfter currency must match transaction currency'
      );
    }
    if (
      (this.referenceExternalTransactionId !== undefined || this.requiresReference()) &&
      referenceTransactionId === undefined
    ) {
      throw new InvalidWagerTransactionError(
        'referenceTransactionId is required when the transaction carries a reference'
      );
    }
    if (referenceTransactionId !== undefined) {
      assertNonEmpty(referenceTransactionId, 'referenceTransactionId');
    }

    const resolvedAt = at ?? new Date();
    this._status = WagerTransactionStatus.Processed;
    this._balanceAfter = balanceAfter;
    this._referenceTransactionId = referenceTransactionId;
    this._failureCode = undefined;
    this._processedAt = resolvedAt;
    this._resolvedAt = resolvedAt;
    this._updatedAt = resolvedAt;
    this.clearPendingSchedule();
  }

  markPendingReference(at?: Date, schedule?: PendingReferenceSchedule): void {
    assertTerminalGuard(this);
    if (this._status !== WagerTransactionStatus.Pending) {
      throw new InvalidTransactionStateError(
        `Cannot mark PENDING_REFERENCE from state ${this._status}`
      );
    }
    if (this.referenceExternalTransactionId === undefined) {
      throw new InvalidWagerTransactionError(
        'PENDING_REFERENCE requires referenceExternalTransactionId'
      );
    }
    if (schedule !== undefined) {
      if (schedule.nextReferenceAttemptAt > schedule.referenceExpiresAt) {
        throw new InvalidWagerTransactionError(
          'nextReferenceAttemptAt must not be after referenceExpiresAt'
        );
      }
      this._nextReferenceAttemptAt = schedule.nextReferenceAttemptAt;
      this._referenceExpiresAt = schedule.referenceExpiresAt;
    }
    this._status = WagerTransactionStatus.PendingReference;
    this._updatedAt = at ?? new Date();
  }

  rescheduleReferenceAttempt(
    nextReferenceAttemptAt: Date,
    at: Date,
    incrementAttempts: boolean
  ): void {
    if (this._status !== WagerTransactionStatus.PendingReference) {
      throw new InvalidTransactionStateError(
        `Cannot reschedule a reference from state ${this._status}`
      );
    }
    if (this._referenceExpiresAt === undefined) {
      throw new InvalidWagerTransactionError(
        'PENDING_REFERENCE has no reference expiration scheduled'
      );
    }
    if (nextReferenceAttemptAt > this._referenceExpiresAt) {
      throw new InvalidWagerTransactionError(
        'nextReferenceAttemptAt must not be after referenceExpiresAt'
      );
    }
    if (incrementAttempts) {
      this._referenceAttempts += 1;
    }
    this._nextReferenceAttemptAt = nextReferenceAttemptAt;
    this._referenceLastAttemptAt = at;
    this._updatedAt = at;
  }

  reject(code: FailureCode, at?: Date): void {
    assertTerminalGuard(this);
    const resolvedAt = at ?? new Date();
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._resolvedAt = resolvedAt;
    this._updatedAt = resolvedAt;
    this.clearPendingSchedule();
  }

  fail(code: FailureCode, at?: Date): void {
    assertTerminalGuard(this);
    const resolvedAt = at ?? new Date();
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._resolvedAt = resolvedAt;
    this._updatedAt = resolvedAt;
    this.clearPendingSchedule();
  }

  private clearPendingSchedule(): void {
    this._nextReferenceAttemptAt = undefined;
    this._referenceExpiresAt = undefined;
  }

  isTerminal(): boolean {
    return (
      this._status === WagerTransactionStatus.Processed ||
      this._status === WagerTransactionStatus.Rejected ||
      this._status === WagerTransactionStatus.Failed
    );
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  acceptsReference(): boolean {
    return (
      this.kind === WagerTransactionKind.Win ||
      this.kind === WagerTransactionKind.Loss ||
      this.kind === WagerTransactionKind.Refund ||
      this.kind === WagerTransactionKind.Rollback
    );
  }

  isSettlement(): boolean {
    return this.kind === WagerTransactionKind.Win || this.kind === WagerTransactionKind.Loss;
  }

  canReverse(targetKind: WagerTransactionKind): boolean {
    if (this.kind === WagerTransactionKind.Refund) {
      return targetKind === WagerTransactionKind.Bet;
    }
    if (this.kind === WagerTransactionKind.Rollback) {
      return (
        targetKind === WagerTransactionKind.Bet ||
        targetKind === WagerTransactionKind.Win ||
        targetKind === WagerTransactionKind.Refund
      );
    }
    return false;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection | undefined {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Loss:
        return undefined;
      case WagerTransactionKind.Rollback: {
        if (reference === undefined) {
          throw new InvalidWagerTransactionError('ROLLBACK requires a reference transaction');
        }
        const direction = reference.ledgerDirectionFor();
        if (direction === undefined) {
          throw new InvalidWagerTransactionError(
            `Cannot roll back a transaction without balance effect: ${reference.kind}`
          );
        }
        return direction === LedgerDirection.Debit ? LedgerDirection.Credit : LedgerDirection.Debit;
      }
    }
  }
}
