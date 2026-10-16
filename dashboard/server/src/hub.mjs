// Synchronous in-memory pub/sub keyed by runId. `emit` is deliberately
// synchronous (the run manager requires a sync emit) and never throws: each
// subscriber is isolated so one failing consumer cannot affect the others.
export function createHub() {
  const subs = new Map(); // runId -> Set<entry>

  function emit(runId, event) {
    const set = subs.get(runId);
    if (!set) return;
    for (const entry of [...set]) {
      try {
        entry.fn(event);
      } catch {
        // isolated: a throwing subscriber must not break fan-out
      }
    }
  }

  function subscribe(runId, fn) {
    const entry = { fn };
    let set = subs.get(runId);
    if (!set) {
      set = new Set();
      subs.set(runId, set);
    }
    set.add(entry);
    return function unsubscribe() {
      const current = subs.get(runId);
      if (!current) return;
      current.delete(entry);
      if (current.size === 0) subs.delete(runId);
    };
  }

  function subscriberCount(runId) {
    return subs.get(runId)?.size ?? 0;
  }

  return { emit, subscribe, subscriberCount };
}
