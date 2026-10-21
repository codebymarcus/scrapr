import { BatchRunner } from "../../../src/pipeline.mjs";
import { StoreJobSource } from "../../../src/sources.mjs";
import { boundResolver } from "../../../src/recipes/recipe.mjs";
import { createEventLogger } from "../../../src/events/event-logger.mjs";
import { needsReview } from "../../../src/recipes/review.mjs";
import { buildRunConfig } from "./build-run-config.mjs";
import { createRowLimiter } from "./row-limiter.mjs";

export const defaultRunnerFactory = (config, logger, deps) => new BatchRunner(config, logger, deps);

// Ceiling on the TOTAL number of rows scraping at once across ALL runs. One shared
// limiter enforces it, so e.g. two runs set to 5 rows each can't open 10 pages.
export const GLOBAL_MAX_CONCURRENT_ROWS = 6;

// Ceiling on the number of runs executing at once. The auto-drain only ever fills
// ONE running run on its own; the second concurrent slot is claimed solely by an
// explicit operator Start (start() allows the count to go 1 -> MAX_CONCURRENT_RUNS).
export const MAX_CONCURRENT_RUNS = 2;

// Runs up to MAX_CONCURRENT_RUNS scrapes at once. A start() beyond the cap leaves
// its run queued; when a running run reaches a terminal state the FIFO queue is
// auto-drained back up to a single running run (see startNextQueued).
//
// start(runId) resolves to:
//   "not-startable" - the run does not exist or is not `queued`/`stopped` (nothing executed)
//   "queued"        - the cap is full; this run waits its turn
//   otherwise       - the run's final state ("done" | "failed" | "stopped")
export function createRunManager({
  store,
  emit,
  runnerFactory = defaultRunnerFactory,
  now = () => new Date().toISOString(),
  runOutDir,
  driveAuth: driveAuthService,
}) {
  // Registry of the currently executing runs, keyed by runId.
  // entry: { runId, runner, stopRequested, promise }
  const active = new Map();
  const runningCount = () => active.size;
  // Runs that failed to leave `queued` (finish() could not persist a terminal
  // state). The auto-drain skips them so a broken row cannot be re-picked forever.
  const orphans = new Set();
  // Set by shutdown(): the queue is no longer auto-drained.
  let draining = false;
  // One semaphore shared by every run: caps total concurrent rows across all runs.
  const rowLimiter = createRowLimiter(GLOBAL_MAX_CONCURRENT_ROWS);

  function safeEmit(runId, event) {
    try {
      emit(runId, event);
    } catch {
      // emit is best-effort: a throwing broadcast must never fail a run.
    }
  }

  function safeStop(runner) {
    try {
      runner?.stop();
    } catch {
      // A throwing stop() must not propagate.
    }
  }

  function finish(runId, state) {
    try {
      store.setRunState(runId, state, { finishedAt: now() });
    } catch {
      // A store failure here must not wedge the queue.
    }
    try {
      if (store.getRun(runId)?.state === "queued") orphans.add(runId);
      else orphans.delete(runId);
    } catch {
      orphans.add(runId);
    }
    safeEmit(runId, { type: "state", state });
  }

  async function execute(entry) {
    const { runId } = entry;
    let state = "failed";
    try {
      const run = store.getRun(runId);
      const project = run && store.getProject(run.project_id);
      if (!project) throw new Error(`run ${runId} has no project`);
      const recipe = project.recipe;

      store.setRunState(runId, "running", { startedAt: now() });
      safeEmit(runId, { type: "state", state: "running" });

      // In-memory OAuth credentials (null when Drive is not connected -> engine falls back to files).
      const driveAuth = driveAuthService?.loadAuthConfig?.() ?? undefined;
      const config = buildRunConfig(recipe, { runOutDir: runOutDir(run), overrides: run.overrides, driveAuth });
      const logger = createEventLogger((ev) => safeEmit(runId, ev));

      // Must never throw: a throwing onItem would abort the whole batch.
      const onItem = (rec) => {
        try {
          const review = needsReview(rec, recipe);
          store.setItemResult(rec.id, {
            saved: rec.saved,
            total: rec.total,
            needsReview: review,
            outputName: rec.outputName,
            bytes: rec.bytes,
          });
          if (rec.uploaded) {
            store.setItemUpload(rec.id, {
              uploadedAt: now(),
              driveLink: rec.driveLink,
              outputSize: rec.outputSize,
            });
          }
          // Read the row back so the event carries exactly what a refetch would:
          // status/reason were persisted by the engine before onItem fired, and
          // uploaded_at was just written above. The client row then updates live.
          const row = store.getItem(rec.id);
          safeEmit(runId, {
            type: "item",
            id: rec.id,
            url: rec.url,
            saved: rec.saved,
            total: rec.total,
            ok: rec.ok,
            needsReview: review,
            outputName: rec.outputName ?? null,
            uploaded: !!rec.uploaded,
            driveLink: rec.driveLink ?? null,
            status: row?.status,
            reason: row?.reason ?? null,
            uploadedAt: row?.uploaded_at ?? null,
          });
        } catch (e) {
          try {
            logger.warn(`onItem failed for item ${rec?.id}: ${e?.message ?? e}`);
          } catch {
            // Reporting the failure must not fail either.
          }
        }
      };

      const deps = {
        createJobSource: () => new StoreJobSource(store, runId, logger),
        onItem,
        rowLimiter,
      };
      // A built-in recipe omits resolveProfile so BatchRunner falls back to the engine's
      // URL-matched resolver (the built-in profile); a data recipe binds its own profile.
      if (!recipe.builtIn) deps.resolveProfile = boundResolver(recipe);

      entry.runner = runnerFactory(config, logger, deps);
      // stop() may have been requested between state change and runner creation.
      if (entry.stopRequested) safeStop(entry.runner);
      const code = await entry.runner.run();
      state = entry.stopRequested ? "stopped" : code === 0 || code === undefined ? "done" : "failed";
    } catch {
      state = entry.stopRequested ? "stopped" : "failed";
    } finally {
      finish(runId, state);
    }
    return state;
  }

  // Auto-drain target is ONE running run: the queue only ever refills a single
  // slot on its own. A second concurrent run is started solely by an explicit
  // operator Start, so queued runs wait until the running count returns to zero.
  function startNextQueued() {
    if (draining || runningCount() > 0) return null;
    let next = null;
    try {
      next = store.nextQueuedRun();
    } catch {
      return null;
    }
    if (!next || orphans.has(next.id)) return null;
    return start(next.id);
  }

  function start(runId) {
    let run = null;
    try {
      run = store.getRun(runId);
    } catch {
      return Promise.resolve("not-startable");
    }
    if (!run || (run.state !== "queued" && run.state !== "stopped")) {
      return Promise.resolve("not-startable");
    }
    if (runningCount() >= MAX_CONCURRENT_RUNS) {
      // At the cap: a stopped run asked to start goes back in the queue so the
      // drain picks it up; a queued run simply keeps its place.
      if (run.state === "stopped") {
        try {
          store.setRunState(runId, "queued");
        } catch {
          // stays stopped; the caller can retry
        }
      }
      return Promise.resolve("queued");
    }
    // Claim the slot synchronously so a racing start() counts it against the cap.
    const entry = { runId, runner: null, stopRequested: false, promise: null };
    active.set(runId, entry);
    const promise = execute(entry)
      .finally(() => active.delete(runId))
      .then((state) => {
        startNextQueued(); // fire-and-forget; start() never rejects
        return state;
      });
    entry.promise = promise;
    return promise;
  }

  return {
    start,
    stop(runId) {
      const entry = active.get(runId);
      if (entry) {
        entry.stopRequested = true;
        safeStop(entry.runner);
        return true;
      }
      return false;
    },
    // Stops the auto-drain for good (graceful shutdown): runs left queued stay
    // queued, so idle() only waits on the already-active runs.
    shutdown() {
      draining = true;
    },
    runningCount,
    // The first active run id (back-compat for a single-run caller), or null.
    activeRunId() {
      for (const runId of active.keys()) return runId;
      return null;
    },
    // Every currently executing run id.
    activeRunIds() {
      return [...active.keys()];
    },
    // Resolves once all active runs (and any queue drain they trigger) have settled.
    async idle() {
      while (active.size > 0) {
        await Promise.allSettled([...active.values()].map((e) => e.promise).filter(Boolean));
      }
    },
  };
}
