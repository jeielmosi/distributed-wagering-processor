import { InvalidInboxMessageError } from './inbox-message.errors';

export interface ReceiveInboxProps {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  correlationId?: string;
  receivedAt?: Date;
}

export interface InboxMessageState {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  correlationId?: string;
  receivedAt: Date;
  processedAt?: Date;
}

const PAYLOAD_HASH_PATTERN = /^[0-9a-f]{64}$/;

function assertIdentifier(value: string, field: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new InvalidInboxMessageError(`${field} must be a non-empty string`);
  }
  if (value.length > 255) {
    throw new InvalidInboxMessageError(`${field} must be at most 255 characters`);
  }
}

export class InboxMessage {
  readonly messageId: string;
  readonly consumerName: string;
  readonly payloadHash: string;
  readonly correlationId?: string;
  readonly receivedAt: Date;
  private _processedAt?: Date;

  private constructor(state: InboxMessageState) {
    this.messageId = state.messageId;
    this.consumerName = state.consumerName;
    this.payloadHash = state.payloadHash;
    this.correlationId = state.correlationId;
    this.receivedAt = state.receivedAt;
    this._processedAt = state.processedAt;
  }

  static receive(props: ReceiveInboxProps): InboxMessage {
    assertIdentifier(props.messageId, 'messageId');
    assertIdentifier(props.consumerName, 'consumerName');
    if (!PAYLOAD_HASH_PATTERN.test(props.payloadHash)) {
      throw new InvalidInboxMessageError('payloadHash must be a 64-character hexadecimal string');
    }
    if (props.correlationId !== undefined) {
      assertIdentifier(props.correlationId, 'correlationId');
    }
    const receivedAt = props.receivedAt ?? new Date();
    if (!(receivedAt instanceof Date) || Number.isNaN(receivedAt.getTime())) {
      throw new InvalidInboxMessageError('receivedAt must be a valid Date');
    }
    return new InboxMessage({
      messageId: props.messageId,
      consumerName: props.consumerName,
      payloadHash: props.payloadHash,
      correlationId: props.correlationId,
      receivedAt
    });
  }

  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(state);
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  isProcessed(): boolean {
    return this._processedAt !== undefined;
  }

  markProcessed(at?: Date): void {
    if (this.isProcessed()) {
      throw new InvalidInboxMessageError('Inbox message has already been processed');
    }
    const processedAt = at ?? new Date();
    if (!(processedAt instanceof Date) || Number.isNaN(processedAt.getTime())) {
      throw new InvalidInboxMessageError('processedAt must be a valid Date');
    }
    this._processedAt = processedAt;
  }
}
