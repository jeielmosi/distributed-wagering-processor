export enum PostgresSqlState {
  UniqueViolation = '23505',
  CheckViolation = '23514',
  InvalidTextRepresentation = '22P02',
  StringDataRightTruncation = '22001',
  QueryCanceled = '57014',
  LockNotAvailable = '55P03',
  DeadlockDetected = '40P01',
  SerializationFailure = '40001',
  AdminShutdown = '57P01'
}

export enum ConnectionErrorCode {
  ConnectionRefused = 'ECONNREFUSED',
  ConnectionReset = 'ECONNRESET',
  TimedOut = 'ETIMEDOUT',
  BrokenPipe = 'EPIPE',
  NotFound = 'ENOTFOUND'
}

const TRANSIENT_CODES = new Set<string>([
  PostgresSqlState.QueryCanceled,
  PostgresSqlState.LockNotAvailable,
  PostgresSqlState.DeadlockDetected,
  PostgresSqlState.SerializationFailure,
  PostgresSqlState.AdminShutdown,
  ConnectionErrorCode.ConnectionRefused,
  ConnectionErrorCode.ConnectionReset,
  ConnectionErrorCode.TimedOut,
  ConnectionErrorCode.BrokenPipe,
  ConnectionErrorCode.NotFound
]);

interface ErrorLike {
  code?: unknown;
  constraint?: unknown;
  constraintName?: unknown;
  driverError?: { code?: unknown; constraint?: unknown; constraintName?: unknown };
}

function asErrorLike(error: unknown): ErrorLike {
  return typeof error === 'object' && error !== null ? (error as ErrorLike) : {};
}

export function postgresErrorCode(error: unknown): string | undefined {
  const like = asErrorLike(error);
  const code = like.code ?? like.driverError?.code;
  return typeof code === 'string' ? code : undefined;
}

export function postgresConstraint(error: unknown): string | undefined {
  const like = asErrorLike(error);
  const constraint =
    like.constraint ??
    like.constraintName ??
    like.driverError?.constraint ??
    like.driverError?.constraintName;
  return typeof constraint === 'string' ? constraint : undefined;
}

export function isUniqueViolation(error: unknown): boolean {
  return postgresErrorCode(error) === PostgresSqlState.UniqueViolation;
}

export function isCheckViolation(error: unknown): boolean {
  return postgresErrorCode(error) === PostgresSqlState.CheckViolation;
}

export function isInvalidTextRepresentation(error: unknown): boolean {
  return postgresErrorCode(error) === PostgresSqlState.InvalidTextRepresentation;
}

export function isStringDataRightTruncation(error: unknown): boolean {
  return postgresErrorCode(error) === PostgresSqlState.StringDataRightTruncation;
}

export function isTransientDatabaseError(error: unknown): boolean {
  const code = postgresErrorCode(error);
  return code !== undefined && TRANSIENT_CODES.has(code);
}
