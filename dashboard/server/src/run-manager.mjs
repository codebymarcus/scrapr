import { BatchRunner } from "../../../src/pipeline.mjs";
import { StoreJobSource } from "../../../src/sources.mjs";
import { boundResolver } from "../../../src/recipes/recipe.mjs";
import { createEventLogger } from "../../../src/events/event-logger.mjs";
import { needsReview } from "../../../src/recipes/review.mjs";
import { buildRunConfig } from "./build-run-config.mjs";

export const defaultRunnerFactory = (config, logger, deps) => new BatchRunner(config, logger, deps);

// Runs one scrape at a time. Extra start() calls leave their run queued; when the
// active run reaches a terminal state the next queued run is started.
//
// start(runId) resolves to:
//   "not-startable" - the run does not exist or is not `queued`/`stopped` (nothing executed)
//   "queued"        - another run is active; this run waits its turn
//   otherwise       - the run's final state ("done" | "failed" | "stopped")
export function createRunManager({
  store,
  emit,
  runnerFactory = defaultRunnerFactory,
  now = () => new Date().toISOString(),
  runOutDir,
  driveAuth: driveAuthService,
}) {
  let active = null; // { runId, runner, stopRequested }
  let current = null; // promise of the active run's execution (plus queue drain)
  // Runs that failed to leave `queued` (finish() could not persist a terminal
  // state). The auto-drain skips them so a broken row cannot be re-picked forever.
  const orphans = new Set();
  // Set by shutdown(): the queue is no longer auto-drained.
  let draining = false;

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
      active = null;
      finish(runId, state);
    }
    return state;
  }

  function startNextQueued() {
    if (draining) return null;
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
    if (active) {
      // A stopped run asked to start while another is active goes back in the
      // queue so the drain picks it up.
      if (run.state === "stopped") {
        try {
          store.setRunState(runId, "queued");
        } catch {
          // stays stopped; the caller can retry
        }
      }
      return Promise.resolve("queued");
    }
    // Claim the slot synchronously so a racing start() sees it as active.
    const entry = { runId, runner: null, stopRequested: false };
    active = entry;
    const promise = execute(entry).then((state) => {
      startNextQueued(); // fire-and-forget; start() never rejects
      return state;
    });
    current = promise;
    return promise;
  }

  return {
    start,
    stop(runId) {
      if (active && active.runId === runId) {
        active.stopRequested = true;
        safeStop(active.runner);
        return true;
      }
      return false;
    },
    // Stops the auto-drain for good (graceful shutdown): runs left queued stay
    // queued, so idle() only ever waits on the already-active run.
    shutdown() {
      draining = true;
    },
    activeRunId() {
      return active ? active.runId : null;
    },
    // Resolves once the active run (and any queue drain it triggers) has settled.
    async idle() {
      while (current) {
        const c = current;
        await c.catch(() => {});
        if (current === c) current = null;
      }
    },
  };
}
