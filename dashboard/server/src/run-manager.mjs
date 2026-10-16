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
// start(runId) resolves to "queued" if another run is active, otherwise to the run's
// final state ("done" | "failed" | "stopped").
export function createRunManager({
  store,
  emit,
  runnerFactory = defaultRunnerFactory,
  now = () => new Date().toISOString(),
  runOutDir,
}) {
  let active = null; // { runId, runner, stopRequested }
  let current = null; // promise of the active run's execution (plus queue drain)

  function finish(runId, state) {
    try {
      store.setRunState(runId, state, { finishedAt: now() });
    } catch {
      // A store failure here must not wedge the queue.
    }
    try {
      emit(runId, { type: "state", state });
    } catch {
      // emit is best-effort.
    }
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
      emit(runId, { type: "state", state: "running" });

      const config = buildRunConfig(recipe, { runOutDir: runOutDir(run) });
      const logger = createEventLogger((ev) => emit(runId, ev));

      // Must never throw: a throwing onItem would abort the whole batch.
      const onItem = (rec) => {
        try {
          const review = needsReview(rec, recipe);
          store.setItemResult(rec.id, { saved: rec.saved, total: rec.total, needsReview: review });
          emit(runId, {
            type: "item",
            id: rec.id,
            url: rec.url,
            saved: rec.saved,
            total: rec.total,
            ok: rec.ok,
            needsReview: review,
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
        resolveProfile: boundResolver(recipe),
        onItem,
      };

      entry.runner = runnerFactory(config, logger, deps);
      // stop() may have been requested between state change and runner creation.
      if (entry.stopRequested) entry.runner.stop();
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
    let next = null;
    try {
      next = store.nextQueuedRun();
    } catch {
      return null;
    }
    return next ? start(next.id) : null;
  }

  function start(runId) {
    if (active) return Promise.resolve("queued");
    // Claim the slot synchronously so a racing start() sees it as active.
    const entry = { runId, runner: null, stopRequested: false };
    active = entry;
    const run = execute(entry).then((state) => {
      startNextQueued(); // fire-and-forget; start() never rejects
      return state;
    });
    current = run;
    return run;
  }

  return {
    start,
    stop(runId) {
      if (active && active.runId === runId) {
        active.stopRequested = true;
        active.runner?.stop();
        return true;
      }
      return false;
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
