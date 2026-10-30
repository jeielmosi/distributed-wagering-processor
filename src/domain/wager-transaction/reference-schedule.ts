export const MAX_REFERENCE_ATTEMPTS = 10;
export const PENDING_REFERENCE_TTL_MS = 3600_000;
export const PENDING_TARGET_DELAY_MS = 45_000;
export const REFERENCE_BASE_DELAY_MS = 5000;
export const REFERENCE_MAX_DELAY_MS = 60_000;

export function referenceBackoffDelayMs(attempts: number): number {
  const normalized = Number.isInteger(attempts) && attempts >= 1 ? attempts : 1;
  return Math.min(2 ** (normalized - 1) * REFERENCE_BASE_DELAY_MS, REFERENCE_MAX_DELAY_MS);
}

export function referenceRetryAt(now: Date, delayMs: number, expiresAt: Date): Date {
  const candidate = now.getTime() + delayMs;
  return new Date(Math.min(candidate, expiresAt.getTime()));
}
