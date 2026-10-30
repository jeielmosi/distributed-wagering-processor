import { createHash } from 'node:crypto';

export interface MoneyHashProps {
  amount: string;
  currency: string;
}

export interface WagerPayloadHashInput {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyHashProps;
  referenceExternalTransactionId?: string | null;
}

type CanonicalValue =
  string | number | boolean | null | CanonicalValue[] | { [key: string]: CanonicalValue };

function normalizeAmount(amount: string): string {
  if (!/^\d+(\.\d{1,2})?$/.test(amount)) {
    throw new Error(`Invalid monetary amount for canonical hashing: ${amount}`);
  }
  const [integerPart, decimalPart = ''] = amount.split('.');
  return `${integerPart}.${decimalPart.padEnd(2, '0')}`;
}

function normalizeValue(value: unknown): CanonicalValue | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => normalizeValue(item))
      .filter((item): item is CanonicalValue => item !== undefined);
  }
  if (typeof value === 'object') {
    const result: { [key: string]: CanonicalValue } = {};
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record).sort()) {
      const normalized = normalizeValue(record[key]);
      if (normalized !== undefined) {
        result[key] = normalized;
      }
    }
    return result;
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  throw new Error(`Unsupported value for canonical hashing: ${typeof value}`);
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalizeValue(value) ?? {});
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function hashWagerPayload(input: WagerPayloadHashInput): string {
  const payload: Record<string, unknown> = {
    providerId: input.providerId,
    externalTransactionId: input.externalTransactionId,
    playerId: input.playerId,
    walletId: input.walletId,
    roundId: input.roundId,
    gameId: input.gameId,
    kind: input.kind,
    money: {
      amount: normalizeAmount(input.money.amount),
      currency: input.money.currency.trim().toUpperCase()
    }
  };
  if (
    input.referenceExternalTransactionId !== undefined &&
    input.referenceExternalTransactionId !== null
  ) {
    payload.referenceExternalTransactionId = input.referenceExternalTransactionId;
  }
  return sha256Hex(canonicalJson(payload));
}
