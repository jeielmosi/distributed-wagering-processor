import { hostname } from 'node:os';
import type { LoggerPort } from '../../application/ports/observability.port';

export enum LogLevel {
  Debug = 'DEBUG',
  Info = 'INFO',
  Warn = 'WARN',
  Error = 'ERROR',
  Silent = 'SILENT'
}

export type StructuredLogLevel = Exclude<LogLevel, LogLevel.Silent>;

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  [LogLevel.Debug]: 10,
  [LogLevel.Info]: 20,
  [LogLevel.Warn]: 30,
  [LogLevel.Error]: 40,
  [LogLevel.Silent]: 100
};

function configuredLevel(): LogLevel {
  const value = process.env.LOG_LEVEL?.toUpperCase();
  switch (value) {
    case LogLevel.Debug:
      return LogLevel.Debug;
    case LogLevel.Info:
      return LogLevel.Info;
    case LogLevel.Warn:
      return LogLevel.Warn;
    case LogLevel.Error:
      return LogLevel.Error;
    case LogLevel.Silent:
      return LogLevel.Silent;
    default:
      return LogLevel.Info;
  }
}

export interface LogFields {
  event?: string;
  correlationId?: string;
  causationId?: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  playerId?: string;
  providerId?: string;
  worker?: string;
  queue?: string;
  status?: string;
  failureCode?: string;
  [key: string]: unknown;
}

interface LogRecord extends LogFields {
  timestamp: string;
  level: StructuredLogLevel;
  service: string;
  instanceId: string;
}

const SENSITIVE_TERMS = [
  'payload',
  'body',
  'card',
  'pan',
  'iban',
  'account',
  'money',
  'amount',
  'balance',
  'token',
  'secret',
  'password',
  'authorization',
  'cvv'
] as const;

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return SENSITIVE_TERMS.some((term) => {
    if (normalized === term || normalized.endsWith(term)) {
      return true;
    }
    if (!normalized.startsWith(term)) {
      return false;
    }
    return /[A-Z0-9_]/.test(key[term.length] ?? '');
  });
}

const REDACTED = '[redacted]';
const MAX_STRING_LENGTH = 2000;
const MAX_DEPTH = 4;

export function instanceId(): string {
  return process.env.INSTANCE_ID ?? `${hostname()}:${process.pid}`;
}

export function sanitizeLogValue(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) {
    return '[truncated]';
  }
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value === 'string') {
    return value.length > MAX_STRING_LENGTH
      ? `${value.slice(0, MAX_STRING_LENGTH)}...[truncated]`
      : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value instanceof Error) {
    return sanitizeLogValue(
      {
        name: value.name,
        code: (value as { code?: unknown }).code,
        failureCode: (value as { failureCode?: unknown }).failureCode
      },
      depth + 1
    );
  }
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => sanitizeLogValue(item, depth + 1));
  }
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveKey(key)) {
        result[key] = REDACTED;
        continue;
      }
      const sanitized = sanitizeLogValue(entry, depth + 1);
      if (sanitized !== undefined) {
        result[key] = sanitized;
      }
    }
    return result;
  }
  return undefined;
}

function sanitizeFields(fields: LogFields): LogFields {
  const sanitized = sanitizeLogValue(fields);
  return typeof sanitized === 'object' && sanitized !== null ? (sanitized as LogFields) : {};
}

function write(level: StructuredLogLevel, fields: LogFields): void {
  if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[configuredLevel()]) {
    return;
  }
  const record: LogRecord = {
    timestamp: new Date().toISOString(),
    level,
    service: 'wagering-processor',
    instanceId: instanceId(),
    ...sanitizeFields(fields)
  };
  const line = JSON.stringify(record);
  if (level === LogLevel.Error) {
    console.error(line);
  } else if (level === LogLevel.Warn) {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export class StructuredLogger implements LoggerPort {
  constructor(private readonly base: LogFields = {}) {}

  child(base: LogFields): StructuredLogger {
    return new StructuredLogger({ ...this.base, ...base });
  }

  event(level: StructuredLogLevel, event: string, fields: LogFields = {}): void {
    write(level, { ...this.base, ...fields, event });
  }

  info(event: string, fields: LogFields = {}): void {
    this.event(LogLevel.Info, event, fields);
  }

  warn(event: string, fields: LogFields = {}): void {
    this.event(LogLevel.Warn, event, fields);
  }

  error(event: string, fields: LogFields = {}): void {
    this.event(LogLevel.Error, event, fields);
  }

  debug(event: string, fields: LogFields = {}): void {
    this.event(LogLevel.Debug, event, fields);
  }
}

export const logger = new StructuredLogger();
