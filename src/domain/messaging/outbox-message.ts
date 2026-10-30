import { IntegrationEvent } from '../events/integration-event';
import { InvalidOutboxMessageError } from './outbox-message.errors';

export { InvalidOutboxMessageError } from './outbox-message.errors';

export const MAX_OUTBOX_ATTEMPTS = 10;
export const MAX_OUTBOX_CLAIMS = 20;
export const OUTBOX_BASE_DELAY_MS = 5000;
export const OUTBOX_MAX_DELAY_MS = 60000;

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  claimCount: number;
  nextAttemptAt: Date;
  publishedAt?: Date;
  deadLetteredAt?: Date;
  lastError?: string;
  createdAt?: Date;
}

function assertNonEmpty(value: string, field: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new InvalidOutboxMessageError(`${field} must be a non-empty string`);
  }
}

function assertValidDate(value: Date, field: string): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new InvalidOutboxMessageError(`${field} must be a valid Date`);
  }
}

function backoffDelay(attempts: number): number {
  return Math.min(2 ** (attempts - 1) * OUTBOX_BASE_DELAY_MS, OUTBOX_MAX_DELAY_MS);
}

export class OutboxMessage {
  readonly id: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly occurredAt: Date;
  readonly createdAt: Date;
  private _attempts: number;
  private _claimCount: number;
  private _nextAttemptAt: Date;
  private _publishedAt?: Date;
  private _deadLetteredAt?: Date;
  private _lastError?: string;

  private constructor(state: OutboxMessageState) {
    this.id = state.id;
    this.aggregateId = state.aggregateId;
    this.eventType = state.eventType;
    this.payload = Object.freeze({ ...state.payload });
    this.occurredAt = state.occurredAt;
    this.createdAt = state.createdAt ?? state.occurredAt;
    this._attempts = state.attempts;
    this._claimCount = state.claimCount;
    this._nextAttemptAt = state.nextAttemptAt;
    this._publishedAt = state.publishedAt;
    this._deadLetteredAt = state.deadLetteredAt;
    this._lastError = state.lastError;
  }

  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    const envelope = event.toJSON();
    assertNonEmpty(envelope.eventId, 'eventId');
    assertNonEmpty(envelope.aggregateId, 'aggregateId');
    assertNonEmpty(envelope.eventType, 'eventType');
    assertValidDate(event.occurredAt, 'occurredAt');

    return new OutboxMessage({
      id: envelope.eventId,
      aggregateId: envelope.aggregateId,
      eventType: envelope.eventType,
      payload: envelope as unknown as Record<string, unknown>,
      occurredAt: event.occurredAt,
      attempts: 0,
      claimCount: 0,
      nextAttemptAt: event.occurredAt,
      createdAt: event.occurredAt
    });
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    assertNonEmpty(state.id, 'id');
    assertNonEmpty(state.aggregateId, 'aggregateId');
    assertNonEmpty(state.eventType, 'eventType');
    if (
      typeof state.payload !== 'object' ||
      state.payload === null ||
      Array.isArray(state.payload)
    ) {
      throw new InvalidOutboxMessageError('payload must be an object');
    }
    assertValidDate(state.occurredAt, 'occurredAt');
    assertValidDate(state.nextAttemptAt, 'nextAttemptAt');
    if (!Number.isInteger(state.attempts) || state.attempts < 0) {
      throw new InvalidOutboxMessageError('attempts must be a non-negative integer');
    }
    if (!Number.isInteger(state.claimCount) || state.claimCount < 0) {
      throw new InvalidOutboxMessageError('claimCount must be a non-negative integer');
    }
    return new OutboxMessage(state);
  }

  get attempts(): number {
    return this._attempts;
  }

  get claimCount(): number {
    return this._claimCount;
  }

  get nextAttemptAt(): Date {
    return this._nextAttemptAt;
  }

  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  get deadLetteredAt(): Date | undefined {
    return this._deadLetteredAt;
  }

  get lastError(): string | undefined {
    return this._lastError;
  }

  isPending(): boolean {
    return this._publishedAt === undefined && this._deadLetteredAt === undefined;
  }

  isDue(now: Date): boolean {
    return this.isPending() && this._nextAttemptAt.getTime() <= now.getTime();
  }

  markPublished(at?: Date): void {
    if (!this.isPending()) {
      throw new InvalidOutboxMessageError('Outbox message is not pending');
    }
    const publishedAt = at ?? new Date();
    assertValidDate(publishedAt, 'publishedAt');
    this._publishedAt = publishedAt;
  }

  scheduleRetry(now: Date, error?: string): void {
    if (!this.isPending()) {
      throw new InvalidOutboxMessageError('Outbox message is not pending');
    }
    assertValidDate(now, 'now');
    this._attempts += 1;
    if (error !== undefined) {
      this._lastError = error;
    }
    if (this._attempts >= MAX_OUTBOX_ATTEMPTS) {
      this.markDeadLettered(now, error);
      return;
    }
    this._nextAttemptAt = new Date(now.getTime() + backoffDelay(this._attempts));
  }

  markDeadLettered(at: Date, error?: string): void {
    if (this._publishedAt !== undefined) {
      throw new InvalidOutboxMessageError('Published outbox message cannot be dead-lettered');
    }
    assertValidDate(at, 'deadLetteredAt');
    this._deadLetteredAt = at;
    if (error !== undefined) {
      this._lastError = error;
    }
  }
}
