export enum IntegrationEventType {
  WAGER_TRANSACTION_PROCESSED = 'WAGER_TRANSACTION_PROCESSED',
  WAGER_TRANSACTION_REJECTED = 'WAGER_TRANSACTION_REJECTED',
  WALLET_BALANCE_CHANGED = 'WALLET_BALANCE_CHANGED',
  WAGER_TRANSACTION_PENDING_REFERENCE = 'WAGER_TRANSACTION_PENDING_REFERENCE'
}

const EVENT_TYPE_WIRE_NAME: Record<IntegrationEventType, string> = {
  [IntegrationEventType.WAGER_TRANSACTION_PROCESSED]: 'WagerTransactionProcessed',
  [IntegrationEventType.WAGER_TRANSACTION_REJECTED]: 'WagerTransactionRejected',
  [IntegrationEventType.WALLET_BALANCE_CHANGED]: 'WalletBalanceChanged',
  [IntegrationEventType.WAGER_TRANSACTION_PENDING_REFERENCE]: 'WagerTransactionPendingReference'
};

export function integrationEventWireType(eventType: IntegrationEventType): string {
  return EVENT_TYPE_WIRE_NAME[eventType];
}

export interface EventContext {
  eventId?: string;
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
}

export interface IntegrationEventProps<T> {
  eventId: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
  data: T;
}

export interface IntegrationEventEnvelope<T> {
  eventId: string;
  eventType: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: string;
  version: number;
  data: T;
}

function assertNonEmpty(value: string, field: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
}

export abstract class IntegrationEvent<T> {
  abstract readonly eventType: IntegrationEventType;
  abstract readonly version: number;

  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: Date;
  readonly data: Readonly<T>;

  protected constructor(props: IntegrationEventProps<T>) {
    assertNonEmpty(props.eventId, 'eventId');
    assertNonEmpty(props.aggregateId, 'aggregateId');
    assertNonEmpty(props.correlationId, 'correlationId');
    if (props.causationId !== undefined) {
      assertNonEmpty(props.causationId, 'causationId');
    }
    if (!(props.occurredAt instanceof Date) || Number.isNaN(props.occurredAt.getTime())) {
      throw new Error('occurredAt must be a valid Date');
    }

    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    this.causationId = props.causationId;
    this.occurredAt = props.occurredAt;
    this.data = props.data;
  }

  toJSON(): IntegrationEventEnvelope<T> {
    const envelope: IntegrationEventEnvelope<T> = {
      eventId: this.eventId,
      eventType: integrationEventWireType(this.eventType),
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      occurredAt: this.occurredAt.toISOString(),
      version: this.version,
      data: this.data
    };
    if (this.causationId !== undefined) {
      envelope.causationId = this.causationId;
    }
    return envelope;
  }
}
