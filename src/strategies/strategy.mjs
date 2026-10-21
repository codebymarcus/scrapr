// The scraping-strategy contract shared by every strategy and the orchestrator.
// A strategy is one *way* to acquire a chapter's pages into a shared ImageCapture;
// it returns a ScrapingResult the orchestrator acts on without knowing internals.

export const FailureCode = Object.freeze({
  TIMEOUT: "TIMEOUT",
  NETWORK_ERROR: "NETWORK_ERROR",
  HTTP_ERROR: "HTTP_ERROR",
  BLOCKED: "BLOCKED",
  RATE_LIMITED: "RATE_LIMITED",
  EMPTY_RESULT: "EMPTY_RESULT",
  INCOMPLETE_RESULT: "INCOMPLETE_RESULT",
  NAVIGATION_JUMP: "NAVIGATION_JUMP",
  PARSER_ERROR: "PARSER_ERROR",
  UNKNOWN_ERROR: "UNKNOWN_ERROR"
});

// ScrapingResult constructors. `data` carries { downloaded, total }; the
// validator (not the strategy) is the authority on success vs incomplete, so a
// non-failed strategy returns ok(data) and lets the validator classify.
export const ok = (data = {}, metadata = {}) => ({ status: "success", data, metadata });
export const partial = (data = {}, code = FailureCode.INCOMPLETE_RESULT, message = "", metadata = {}) =>
  ({ status: "incomplete", data, error: { code, message }, metadata });
export const failed = (code = FailureCode.UNKNOWN_ERROR, message = "", metadata = {}) =>
  ({ status: "failed", error: { code, message }, metadata });

// Retryable = transient transport failures worth re-running the SAME strategy.
// Structural failures (incomplete, navigation jump, blocked, empty) are NOT
// retryable; repeating the same approach reproduces them, so the orchestrator
// falls back to the next strategy instead.
const RETRYABLE = new Set([
  FailureCode.TIMEOUT,
  FailureCode.NETWORK_ERROR,
  FailureCode.HTTP_ERROR,
  FailureCode.RATE_LIMITED
]);
export const isRetryable = (code) => RETRYABLE.has(code);

// Map a thrown Playwright/runtime error to a FailureCode.
export function mapError(err) {
  const msg = String(err?.message || err || "").toLowerCase();
  if (err?.name === "TimeoutError" || msg.includes("timeout")) return FailureCode.TIMEOUT;
  if (msg.includes("net::") || msg.includes("econn") || msg.includes("socket") || msg.includes("dns") ||
      msg.includes("network") || msg.includes("fetch failed") || msg.includes("enotfound") || msg.includes("getaddrinfo"))
    return FailureCode.NETWORK_ERROR;
  return FailureCode.UNKNOWN_ERROR;
}
