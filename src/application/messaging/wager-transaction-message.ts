import { WagerTransactionKind } from '../../domain/wager-transaction/wager-transaction-kind';
import type { ProcessWagerTransactionCommand } from '../use-cases/process-wager-transaction.types';

export class InvalidQueueMessageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export interface ParsedWagerTransactionMessage {
  messageId: string;
  correlationId: string;
  command: ProcessWagerTransactionCommand;
}

export enum QueueMessageType {
  WAGER_TRANSACTION_REQUESTED = 'WAGER_TRANSACTION_REQUESTED'
}

const QUEUE_MESSAGE_WIRE_NAME: Record<QueueMessageType, string> = {
  [QueueMessageType.WAGER_TRANSACTION_REQUESTED]: 'WagerTransactionRequested'
};
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KINDS = new Set<string>(Object.values(WagerTransactionKind));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, field: string, maxLength = 255): string {
  if (typeof value !== 'string') {
    throw new InvalidQueueMessageError(`${field} must be a string`);
  }
  if (value.trim().length === 0 || value.length > maxLength) {
    throw new InvalidQueueMessageError(
      `${field} must contain between 1 and ${maxLength} characters`
    );
  }
  return value;
}

function requireUuid(value: unknown, field: string): string {
  const parsed = requireString(value, field);
  if (!UUID_PATTERN.test(parsed)) {
    throw new InvalidQueueMessageError(`${field} must be a valid UUID`);
  }
  return parsed;
}

export function parseWagerTransactionMessage(
  raw: string,
  fallbackCorrelationId: string
): ParsedWagerTransactionMessage {
  let envelope: unknown;
  try {
    envelope = JSON.parse(raw);
  } catch {
    throw new InvalidQueueMessageError('Message body is not valid JSON');
  }
  if (!isRecord(envelope)) {
    throw new InvalidQueueMessageError('Message envelope must be an object');
  }

  if (envelope.type !== QUEUE_MESSAGE_WIRE_NAME[QueueMessageType.WAGER_TRANSACTION_REQUESTED]) {
    throw new InvalidQueueMessageError(`Unsupported message type: ${String(envelope.type)}`);
  }
  const messageId = requireString(envelope.messageId, 'messageId');
  const data = envelope.data;
  if (!isRecord(data)) {
    throw new InvalidQueueMessageError('data must be an object');
  }

  const correlationId =
    envelope.correlationId === undefined
      ? fallbackCorrelationId
      : requireString(envelope.correlationId, 'correlationId');

  const providerId = requireString(data.providerId, 'providerId');
  const externalTransactionId = requireString(data.externalTransactionId, 'externalTransactionId');
  const idempotencyKey = requireString(data.idempotencyKey, 'idempotencyKey');
  const playerId = requireUuid(data.playerId, 'playerId');
  const walletId = requireUuid(data.walletId, 'walletId');
  const roundId = requireString(data.roundId, 'roundId');
  const gameId = requireString(data.gameId, 'gameId');
  const kind = requireString(data.kind, 'kind', 16);
  if (!KINDS.has(kind)) {
    throw new InvalidQueueMessageError(`Unsupported transaction kind: ${kind}`);
  }
  if (!isRecord(data.money)) {
    throw new InvalidQueueMessageError('money must be an object');
  }
  const amount = requireString(data.money.amount, 'money.amount');
  const currency = requireString(data.money.currency, 'money.currency', 3);
  const referenceExternalTransactionId =
    data.referenceExternalTransactionId === undefined
      ? undefined
      : requireString(data.referenceExternalTransactionId, 'referenceExternalTransactionId');

  if (kind === WagerTransactionKind.Bet && referenceExternalTransactionId !== undefined) {
    throw new InvalidQueueMessageError('BET must not carry referenceExternalTransactionId');
  }
  if (
    (kind === WagerTransactionKind.Refund || kind === WagerTransactionKind.Rollback) &&
    referenceExternalTransactionId === undefined
  ) {
    throw new InvalidQueueMessageError(`${kind} requires referenceExternalTransactionId`);
  }
  if (
    referenceExternalTransactionId !== undefined &&
    referenceExternalTransactionId === externalTransactionId
  ) {
    throw new InvalidQueueMessageError('Self-reference is not allowed');
  }

  return {
    messageId,
    correlationId,
    command: {
      providerId,
      externalTransactionId,
      idempotencyKey,
      playerId,
      walletId,
      roundId,
      gameId,
      kind: kind as WagerTransactionKind,
      money: { amount, currency },
      referenceExternalTransactionId,
      correlationId,
      causationId: messageId
    }
  };
}
