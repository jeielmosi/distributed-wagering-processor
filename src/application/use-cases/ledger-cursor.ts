import { InvalidRequestError } from '../errors/application.errors';

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export function encodeLedgerCursor(walletVersion: number): string {
  return Buffer.from(JSON.stringify({ walletVersion }), 'utf8').toString('base64url');
}

export function decodeLedgerCursor(rawCursor: string): number {
  if (!BASE64URL_PATTERN.test(rawCursor)) {
    throw new InvalidRequestError('cursor must be a valid base64url value');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(rawCursor, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidRequestError('cursor must be a valid base64url JSON value');
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new InvalidRequestError('cursor must be an object');
  }

  const walletVersion = (parsed as { walletVersion?: unknown }).walletVersion;
  if (!Number.isInteger(walletVersion) || (walletVersion as number) < 1) {
    throw new InvalidRequestError(
      'cursor.walletVersion must be an integer greater than or equal to 1'
    );
  }

  return walletVersion as number;
}

export function parseLedgerLimit(rawLimit: string | undefined): number {
  if (rawLimit === undefined) {
    return 50;
  }
  const limit = Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new InvalidRequestError('limit must be an integer between 1 and 200');
  }
  return limit;
}
