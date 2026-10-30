import type { LoggerService } from '@nestjs/common';
import type { LoggerPort } from '../../../application/ports/observability.port';

type LogMethod = 'info' | 'warn' | 'error';

function messageFrom(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value instanceof Error) {
    return value.message;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function parseStructured(text: string): Record<string, unknown> {
  if (!text.startsWith('{')) {
    return {};
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export class NestLoggerAdapter implements LoggerService {
  constructor(private readonly logger: LoggerPort) {}

  log(message: unknown, ...optionalParams: unknown[]): void {
    this.emit('info', message, optionalParams);
  }

  error(message: unknown, ...optionalParams: unknown[]): void {
    this.emit('error', message, optionalParams);
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    this.emit('warn', message, optionalParams);
  }

  debug(message: unknown, ...optionalParams: unknown[]): void {
    this.emit('info', message, optionalParams);
  }

  verbose(message: unknown, ...optionalParams: unknown[]): void {
    this.emit('info', message, optionalParams);
  }

  fatal(message: unknown, ...optionalParams: unknown[]): void {
    this.emit('error', message, optionalParams);
  }

  private emit(level: LogMethod, message: unknown, optionalParams: unknown[]): void {
    const context = optionalParams.find((param): param is string => typeof param === 'string');
    const text = messageFrom(message);
    const parsed = parseStructured(text);
    const hasEvent = typeof parsed.event === 'string';
    this.logger[level](hasEvent ? (parsed.event as string) : 'log', {
      ...parsed,
      ...(context === undefined ? {} : { context }),
      ...(hasEvent ? {} : { message: text })
    });
  }
}
