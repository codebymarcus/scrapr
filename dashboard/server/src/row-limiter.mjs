// Global row-slot semaphore.
//
// Caps the TOTAL number of rows scraping at once across ALL runs: one limiter is
// owned by the run manager and injected into every run's engine, so two runs set
// to 5 each can't open 10 browser tabs on a laptop. A worker acquires a slot
// before scraping a row and releases it (in a finally) after.
//
// `createRowLimiter(max)` → { acquire(): Promise<() => void>, inUse(): number }.
// acquire() resolves immediately with a release fn while `inUse < max`; otherwise
// it queues FIFO and resolves when a slot frees. The release fn is idempotent — a
// double-release must not over-credit the semaphore — and pulls the next waiter.
export function createRowLimiter(max) {
  // Clamp so a misconfigured max can never deadlock acquire().
  const limit = Math.max(1, Math.floor(Number(max) || 0));
  let inUse = 0;
  const waiters = []; // FIFO queue of resolve fns waiting for a slot

  // An idempotent release for one held slot: on the FIRST call it either hands the
  // slot straight to the next FIFO waiter (inUse unchanged: one holder leaves, one
  // enters) or frees it (inUse--). Later calls are no-ops, so a double-release can
  // never over-credit the semaphore.
  function makeRelease() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = waiters.shift();
      if (next) next(makeRelease());
      else inUse--;
    };
  }

  return {
    acquire() {
      return new Promise((resolve) => {
        if (inUse < limit) {
          inUse++;
          resolve(makeRelease());
        } else {
          // Queued: a future release will admit us (and count our slot then).
          waiters.push(resolve);
        }
      });
    },
    inUse() {
      return inUse;
    },
  };
}
