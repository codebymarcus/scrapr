// Per-domain circuit breaker + adaptive backoff for one batch run. Pure and
// stateful; no I/O. The batch loop records each job's outcome and consults it to
// slow (extraDelay) then skip (isTripped) a domain that keeps failing hard.
import { FailureCode, mapError } from "./strategies/strategy.mjs";

// Codes that mean the domain/server is unhealthy — the only ones that count
// toward the breaker and the backoff. Content failures and UNKNOWN_ERROR do not,
// so a flaky chapter can't blacklist a healthy domain.
export const DOMAIN_HEALTH_CODES = new Set([
  FailureCode.RATE_LIMITED,
  FailureCode.BLOCKED,
  FailureCode.HTTP_ERROR,
  FailureCode.TIMEOUT,
  FailureCode.NETWORK_ERROR
]);

// The hostname key for a job URL (stable even on a malformed URL).
export function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return String(url); }
}

// The primary FailureCode of a finished job result, or null when it succeeded.
export function failureCodeOf(result) {
  if (!result || result.ok) return null;
  if (result.error) return mapError(result.error);
  const attempts = result.attempts;
  if (Array.isArray(attempts) && attempts.length) {
    return attempts[attempts.length - 1].code || FailureCode.UNKNOWN_ERROR;
  }
  return FailureCode.UNKNOWN_ERROR;
}

export class CircuitBreaker {
  constructor(threshold = 3, { base = 3000, cap = 60000 } = {}) {
    this.threshold = Number.isInteger(threshold) ? threshold : 3;
    this.base = base;
    this.cap = cap;
    this._fails = new Map();   // host -> consecutive domain-health failures
    this._tripped = new Set();
    this.skippedCount = 0;
  }

  enabled() { return this.threshold > 0; }

  record(host, { ok, code } = {}) {
    if (!this.enabled()) return;
    if (ok) { this._fails.set(host, 0); return; }
    if (!DOMAIN_HEALTH_CODES.has(code)) return;
    const n = (this._fails.get(host) || 0) + 1;
    this._fails.set(host, n);
    if (n >= this.threshold) this._tripped.add(host);
  }

  isTripped(host) { return this.enabled() && this._tripped.has(host); }

  extraDelay(host) {
    if (!this.enabled()) return 0;
    const n = this._fails.get(host) || 0;
    if (n <= 0) return 0;
    return Math.min(this.cap, this.base * 2 ** (n - 1));
  }

  noteSkip() { this.skippedCount++; }

  trippedHosts() { return [...this._tripped]; }
}
