import { ApiError } from "./http/api-error";

/**
 * Shared React Query `retry` predicate.
 *
 * - network / timeout / parse / shape errors can't be fixed by retrying.
 * - http: retry the transient 408/429 once; retry 5xx up to twice; never
 *   retry other 4xx.
 * - An unexpected non-ApiError retries up to twice.
 */
export function retryApiQuery(failureCount: number, error: Error): boolean {
  if (error instanceof ApiError) {
    switch (error.kind) {
      case "network":
      case "timeout":
      case "parse":
      case "shape":
        return false;
      case "http":
        if (error.status === 408 || error.status === 429) {
          return failureCount < 1;
        }
        if (error.status !== undefined && error.status >= 500) {
          return failureCount < 2;
        }
        return false;
    }
  }

  return failureCount < 2;
}
