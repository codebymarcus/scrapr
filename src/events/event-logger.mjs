// Structured-event logger: exposes the same method surface as createLogger, but
// forwards every call as a plain-object event to an injected `emit` callback
// (e.g. a WebSocket feed for the dashboard). When a base logger is given, each
// call is also teed to it so console and --log-file output are unchanged.
//
// emit() is isolated: a throwing emit is swallowed (and noted on base.debug) so
// a dashboard disconnect can never break a scrape.

const TEXT_METHODS = [
  "info", "success", "warn", "muted", "step", "section", "error", "verbose", "debug",
];

const toText = (m) => (typeof m === "string" ? m : m?.message || String(m));

// Contract: the injected `emit` MUST be SYNCHRONOUS. Only a synchronous throw is swallowed
// below; a returned rejected Promise would escape (unhandled rejection) because the result
// is neither awaited nor caught. An async transport must handle its own errors internally.
export function createEventLogger(emit, base = null) {
  const send = (event) => {
    try {
      emit(event);
    } catch (err) {
      try {
        if (typeof base?.debug === "function") base.debug(`event emit failed: ${err?.message ?? err}`);
      } catch {
        // Logging about a failed emit must not fail either.
      }
    }
  };

  const tee = (method, args) => {
    const fn = base?.[method];
    if (typeof fn === "function") return fn.apply(base, args);
  };

  const log = {};

  for (const method of TEXT_METHODS) {
    log[method] = (...args) => {
      send({ type: "log", level: method, message: toText(args[0]), ts: Date.now() });
      tee(method, args);
    };
  }

  log.progressBar = (current, total, label = "", ...rest) => {
    send({ type: "progress", current, total, label, ts: Date.now() });
    tee("progressBar", [current, total, label, ...rest]);
  };

  log.endProgress = () => {
    send({ type: "progress-end", ts: Date.now() });
    tee("endProgress", []);
  };

  log.close = async () => {
    await base?.close?.();
  };

  // A logger bound to one row: identical surface, but page-progress events carry the
  // row's itemId so concurrent rows can be told apart. Reuses this closure's send/tee.
  log.forItem = (itemId) => ({
    ...log,
    progressBar: (current, total, label = "", ...rest) => {
      send({ type: "progress", itemId, current, total, label, ts: Date.now() });
      tee("progressBar", [current, total, label, ...rest]);
    },
    endProgress: () => {
      send({ type: "progress-end", itemId, ts: Date.now() });
      tee("endProgress", []);
    },
  });

  return log;
}
