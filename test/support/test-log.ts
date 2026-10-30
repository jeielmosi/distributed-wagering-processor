export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return `${error.name}: ${error.message}${code === undefined ? '' : ` (code=${String(code)})`}`;
  }
  return String(error);
}

export function logTestEvent(scope: string, error: unknown): void {
  console.warn(`[test] ${scope}: ${describeError(error)}`);
}

export function logCleanupFailure(scope: string, error: unknown): void {
  console.warn(`[test] ${scope} failed: ${describeError(error)}`);
}
