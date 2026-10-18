import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db/db.mjs";
import { migrate } from "../src/db/migrations.mjs";
import { createStore } from "../src/db/store.mjs";
import { createRunManager } from "../src/run-manager.mjs";

const imageRecipe = { name: "Img", contentType: "image" };

function setup() {
  const db = openDb();
  migrate(db);
  const store = createStore(db);
  const project = store.createProject({ name: "P", recipe: imageRecipe });
  const events = [];
  const emit = (runId, ev) => events.push({ runId, ev });
  const makeRun = (urls) => {
    const run = store.createRun({ projectId: project.id, label: "L" });
    store.addItems(run.id, urls);
    return run;
  };
  return { db, store, project, events, emit, makeRun };
}

// A controllable fake runner. `script(runner, deps, config)` is the run body.
function fakeFactory(script) {
  const created = [];
  const factory = (config, logger, deps) => {
    const runner = {
      config, logger, deps, stopped: false,
      stop() { runner.stopped = true; },
      run: async () => script(runner, deps, config),
    };
    created.push(runner);
    return runner;
  };
  factory.created = created;
  return factory;
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

test("start runs the run: running -> done, with config and items processed", async () => {
  const { db, store, emit, makeRun, events } = setup();
  const run = makeRun(["https://e.com/1", "https://e.com/2"]);
  let stateDuringRun;
  const factory = fakeFactory(async (_r, deps) => {
    stateDuringRun = store.getRun(run.id).state;
    const jobs = await deps.createJobSource().load();
    assert.equal(jobs.length, 2);
    return 0;
  });
  const mgr = createRunManager({ store, emit, runnerFactory: factory, now: () => "2026-01-01T00:00:00.000Z", runOutDir: (r) => `/out/${r.id}` });
  await mgr.start(run.id);
  assert.equal(stateDuringRun, "running");
  const done = store.getRun(run.id);
  assert.equal(done.state, "done");
  assert.equal(done.started_at, "2026-01-01T00:00:00.000Z");
  assert.equal(done.finished_at, "2026-01-01T00:00:00.000Z");
  assert.equal(factory.created[0].config.out, `/out/${run.id}`);
  assert.equal(mgr.activeRunId(), null);
  assert.ok(events.every((e) => e.runId === run.id));
  db.close();
});

test("execute merges run overrides and in-memory driveAuth into the engine config", async () => {
  const { db, store, project, emit } = setup();
  const run = store.createRun({
    projectId: project.id,
    label: "L",
    overrides: { drive: true, driveFolder: "FOLDER", driveSubfolder: "sub" },
  });
  store.addItems(run.id, ["https://e.com/1"]);
  const creds = { clientId: "cid", clientSecret: "sec", token: { refresh_token: "r" } };
  const driveAuth = { loadAuthConfig: () => creds };
  const factory = fakeFactory(async () => 0);
  const mgr = createRunManager({ store, emit, runnerFactory: factory, runOutDir: () => "/o", driveAuth });
  await mgr.start(run.id);
  const cfg = factory.created[0].config;
  assert.equal(cfg.drive, true);
  assert.equal(cfg.driveFolder, "FOLDER");
  assert.equal(cfg.driveSubfolder, "sub");
  assert.deepEqual(cfg.driveAuth, creds);
  // The project recipe is not mutated by the overrides.
  assert.deepEqual(store.getProject(project.id).recipe, imageRecipe);
  db.close();
});

test("execute without driveAuth or overrides leaves config.driveAuth unset; unconfigured auth (null) too", async () => {
  const { db, store, emit, makeRun } = setup();
  const a = makeRun(["https://e.com/1"]);
  const f1 = fakeFactory(async () => 0);
  await createRunManager({ store, emit, runnerFactory: f1, runOutDir: () => "/o" }).start(a.id);
  assert.equal(f1.created[0].config.driveAuth, undefined);

  const b = makeRun(["https://e.com/1"]);
  const f2 = fakeFactory(async () => 0);
  const driveAuth = { loadAuthConfig: () => null };
  await createRunManager({ store, emit, runnerFactory: f2, runOutDir: () => "/o", driveAuth }).start(b.id);
  assert.equal(f2.created[0].config.driveAuth, undefined);
  db.close();
});

test("onItem stores result, flags zero-saved as needs_review, and emits an item event", async () => {
  const { db, store, emit, makeRun, events } = setup();
  const run = makeRun(["https://e.com/1", "https://e.com/2"]);
  const [a, b] = store.listItems(run.id);
  const factory = fakeFactory(async (_r, deps) => {
    deps.onItem({ id: a.id, url: a.url, complete: true, saved: 0, total: 10 });
    deps.onItem({ id: b.id, url: b.url, complete: true, saved: 5, total: 5 });
    return 0;
  });
  const mgr = createRunManager({ store, emit, runnerFactory: factory, runOutDir: () => "/o" });
  await mgr.start(run.id);
  const items = store.listItems(run.id);
  assert.equal(items[0].needs_review, 1);
  assert.equal(items[0].saved, 0);
  assert.equal(items[1].needs_review, 0);
  assert.equal(items[1].saved, 5);
  assert.equal(items[1].total, 5);
  const itemEvents = events.filter((e) => e.ev.type === "item");
  assert.equal(itemEvents.length, 2);
  assert.equal(itemEvents[0].ev.id, a.id);
  assert.equal(itemEvents[0].ev.needsReview, true);
  db.close();
});

test("onItem persists output name + upload state and emits them on the item event", async () => {
  const { db, store, emit, makeRun, events } = setup();
  const run = makeRun(["https://e.com/1", "https://e.com/2"]);
  const [a, b] = store.listItems(run.id);
  const factory = fakeFactory(async (_r, deps) => {
    deps.onItem({ id: a.id, url: a.url, saved: 3, total: 3, ok: true, outputName: "Issue 1", uploaded: true, driveLink: "http://d/1", bytes: 5000, outputSize: 4096 });
    deps.onItem({ id: b.id, url: b.url, saved: 2, total: 2, ok: true, outputName: "Issue 2", uploaded: false, driveLink: null, bytes: 700, outputSize: null });
    return 0;
  });
  const mgr = createRunManager({ store, emit, runnerFactory: factory, runOutDir: () => "/o" });
  await mgr.start(run.id);
  const ia = store.getItem(a.id);
  assert.equal(ia.output_name, "Issue 1");
  assert.ok(ia.uploaded_at);
  assert.equal(ia.drive_link, "http://d/1");
  assert.equal(ia.bytes, 5000);
  assert.equal(ia.output_size, 4096);
  const ib = store.getItem(b.id);
  assert.equal(ib.output_name, "Issue 2");
  assert.ok(!ib.uploaded_at);
  assert.ok(!ib.drive_link);
  assert.equal(ib.bytes, 700);
  assert.equal(ib.output_size, null);
  const itemEvents = events.filter((e) => e.ev.type === "item");
  assert.equal(itemEvents[0].ev.outputName, "Issue 1");
  assert.equal(itemEvents[0].ev.uploaded, true);
  assert.equal(itemEvents[0].ev.driveLink, "http://d/1");
  assert.equal(itemEvents[1].ev.outputName, "Issue 2");
  assert.equal(itemEvents[1].ev.uploaded, false);
  assert.equal(itemEvents[1].ev.driveLink, null);
  db.close();
});

test("a throwing onItem body is swallowed and does not crash the run", async () => {
  const { db, store, emit, makeRun } = setup();
  const run = makeRun(["https://e.com/1"]);
  const factory = fakeFactory(async (_r, deps) => {
    // Unknown id (no row) plus a store that throws.
    store.setItemResult = () => { throw new Error("db locked"); };
    assert.doesNotThrow(() => deps.onItem({ id: 1, complete: true, saved: 1, total: 1 }));
    assert.doesNotThrow(() => deps.onItem(null));
    return 0;
  });
  const mgr = createRunManager({ store, emit, runnerFactory: factory, runOutDir: () => "/o" });
  await mgr.start(run.id);
  assert.equal(store.getRun(run.id).state, "done");
  db.close();
});

test("a second start while active does not run concurrently; queued run auto-starts after", async () => {
  const { db, store, emit, makeRun } = setup();
  const r1 = makeRun(["https://e.com/1"]);
  const r2 = makeRun(["https://e.com/2"]);
  const gate = deferred();
  let concurrent = 0;
  let maxConcurrent = 0;
  const factory = fakeFactory(async () => {
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    if (factory.created.length === 1) await gate.promise;
    concurrent -= 1;
    return 0;
  });
  const mgr = createRunManager({ store, emit, runnerFactory: factory, runOutDir: () => "/o" });
  const p1 = mgr.start(r1.id);
  assert.equal(mgr.activeRunId(), r1.id);
  const second = await mgr.start(r2.id);
  assert.equal(second, "queued");
  assert.equal(store.getRun(r2.id).state, "queued");
  assert.equal(factory.created.length, 1);

  gate.resolve();
  await p1;
  // r2 was auto-started on completion of r1 and its (instant) fake run finishes.
  await mgr.idle();
  assert.equal(store.getRun(r1.id).state, "done");
  assert.equal(store.getRun(r2.id).state, "done");
  assert.equal(factory.created.length, 2);
  assert.equal(maxConcurrent, 1);
  assert.equal(mgr.activeRunId(), null);
  db.close();
});

test("stop calls the runner's stop() and the run ends stopped", async () => {
  const { db, store, emit, makeRun } = setup();
  const run = makeRun(["https://e.com/1"]);
  const gate = deferred();
  const factory = fakeFactory(async (runner) => {
    await gate.promise;
    return runner.stopped ? 0 : 0;
  });
  const mgr = createRunManager({ store, emit, runnerFactory: factory, runOutDir: () => "/o" });
  const p = mgr.start(run.id);
  assert.equal(mgr.stop(run.id), true);
  assert.equal(factory.created[0].stopped, true);
  gate.resolve();
  await p;
  assert.equal(store.getRun(run.id).state, "stopped");
  assert.ok(store.getRun(run.id).finished_at);
  db.close();
});

test("stop of an unknown / inactive run returns false", async () => {
  const { db, store, emit } = setup();
  const mgr = createRunManager({ store, emit, runnerFactory: fakeFactory(async () => 0), runOutDir: () => "/o" });
  assert.equal(mgr.stop(999), false);
  db.close();
});

test("runner failure (nonzero exit or throw) marks the run failed and still drains the queue", async () => {
  const { db, store, emit, makeRun } = setup();
  const r1 = makeRun(["https://e.com/1"]);
  const r2 = makeRun(["https://e.com/2"]);
  const r3 = makeRun(["https://e.com/3"]);
  let n = 0;
  const factory = fakeFactory(async () => {
    n += 1;
    if (n === 1) throw new Error("boom");
    if (n === 2) return 1;
    return 0;
  });
  const mgr = createRunManager({ store, emit, runnerFactory: factory, runOutDir: () => "/o" });
  await mgr.start(r1.id);
  await mgr.idle();
  assert.equal(store.getRun(r1.id).state, "failed");
  assert.equal(store.getRun(r2.id).state, "failed");
  assert.equal(store.getRun(r3.id).state, "done");
  db.close();
});

test("a run that cannot be set up (missing project) is failed, not left running", async () => {
  const { db, store, emit, makeRun, project } = setup();
  const run = makeRun(["https://e.com/1"]);
  db.prepare("PRAGMA foreign_keys = OFF").run();
  store.deleteProject(project.id);
  const mgr = createRunManager({ store, emit, runnerFactory: fakeFactory(async () => 0), runOutDir: () => "/o" });
  await mgr.start(run.id);
  assert.equal(store.getRun(run.id).state, "failed");
  assert.equal(mgr.activeRunId(), null);
  db.close();
});

test("start ignores runs that are not queued/stopped (no runner is created)", async () => {
  const { db, store, emit, makeRun } = setup();
  const factory = fakeFactory(async () => 0);
  const mgr = createRunManager({ store, emit, runnerFactory: factory, runOutDir: () => "/o" });
  for (const state of ["running", "done", "failed"]) {
    const run = makeRun(["https://e.com/1"]);
    store.setRunState(run.id, state);
    assert.equal(await mgr.start(run.id), "not-startable");
    assert.equal(store.getRun(run.id).state, state);
  }
  assert.equal(await mgr.start(9999), "not-startable");
  assert.equal(factory.created.length, 0);
  assert.equal(mgr.activeRunId(), null);
  db.close();
});

test("a stopped run can be started again", async () => {
  const { db, store, emit, makeRun } = setup();
  const run = makeRun(["https://e.com/1"]);
  store.setRunState(run.id, "stopped");
  const factory = fakeFactory(async () => 0);
  const mgr = createRunManager({ store, emit, runnerFactory: factory, runOutDir: () => "/o" });
  assert.equal(await mgr.start(run.id), "done");
  assert.equal(factory.created.length, 1);
  db.close();
});

test("a stopped run started while another is active is re-queued and drained", async () => {
  const { db, store, emit, makeRun } = setup();
  const r1 = makeRun(["https://e.com/1"]);
  const r2 = makeRun(["https://e.com/2"]);
  store.setRunState(r2.id, "stopped");
  const gate = deferred();
  const factory = fakeFactory(async () => {
    if (factory.created.length === 1) await gate.promise;
    return 0;
  });
  const mgr = createRunManager({ store, emit, runnerFactory: factory, runOutDir: () => "/o" });
  const p1 = mgr.start(r1.id);
  assert.equal(await mgr.start(r2.id), "queued");
  assert.equal(store.getRun(r2.id).state, "queued");
  gate.resolve();
  await p1;
  await mgr.idle();
  assert.equal(store.getRun(r2.id).state, "done");
  db.close();
});

test("a throwing emit (including the running-state emit) does not fail the run", async () => {
  const { db, store, makeRun } = setup();
  const run = makeRun(["https://e.com/1"]);
  const factory = fakeFactory(async () => 0);
  const emit = () => { throw new Error("broadcast down"); };
  const mgr = createRunManager({ store, emit, runnerFactory: factory, runOutDir: () => "/o" });
  assert.equal(await mgr.start(run.id), "done");
  assert.equal(factory.created.length, 1);
  assert.equal(store.getRun(run.id).state, "done");
  db.close();
});

test("a throwing runner.stop() is swallowed", async () => {
  const { db, store, emit, makeRun } = setup();
  const run = makeRun(["https://e.com/1"]);
  const gate = deferred();
  const factory = (config, logger, deps) => {
    const runner = {
      stop() { throw new Error("stop failed"); },
      run: async () => { await gate.promise; return 0; },
    };
    factory.created.push(runner);
    return runner;
  };
  factory.created = [];
  const mgr = createRunManager({ store, emit, runnerFactory: factory, runOutDir: () => "/o" });
  const p = mgr.start(run.id);
  assert.doesNotThrow(() => mgr.stop(run.id));
  gate.resolve();
  assert.equal(await p, "stopped");
  assert.equal(store.getRun(run.id).state, "stopped");

  db.close();
});

test("an orphan queued row (state cannot be persisted) is not re-picked forever", async () => {
  const { db, store, emit, makeRun } = setup();
  const run = makeRun(["https://e.com/1"]);
  const realSet = store.setRunState;
  store.setRunState = (id, state, times) => {
    if (state !== "queued") throw new Error("db locked");
    return realSet(id, state, times);
  };
  const factory = fakeFactory(async () => 0);
  const mgr = createRunManager({ store, emit, runnerFactory: factory, runOutDir: () => "/o" });
  assert.equal(await mgr.start(run.id), "failed");
  await mgr.idle(); // would never settle if the drain looped on the orphan
  assert.equal(store.getRun(run.id).state, "queued");
  assert.equal(factory.created.length, 0);
  assert.equal(mgr.activeRunId(), null);
  // An explicit start is still allowed to retry it.
  store.setRunState = realSet;
  assert.equal(await mgr.start(run.id), "done");
  db.close();
});

test("after shutdown(), stopping the active run does not auto-start the queued run", async () => {
  const { db, store, emit, makeRun } = setup();
  const r1 = makeRun(["https://e.com/1"]);
  const r2 = makeRun(["https://e.com/2"]);
  const gate = deferred();
  const factory = fakeFactory(async () => {
    await gate.promise;
    return 0;
  });
  const mgr = createRunManager({ store, emit, runnerFactory: factory, runOutDir: () => "/o" });
  const p1 = mgr.start(r1.id);
  assert.equal(await mgr.start(r2.id), "queued");

  mgr.shutdown();
  assert.equal(mgr.stop(r1.id), true);
  gate.resolve();
  assert.equal(await p1, "stopped");
  await mgr.idle(); // resolves: there is no newly started run to wait on
  assert.equal(factory.created.length, 1);
  assert.equal(store.getRun(r2.id).state, "queued");
  assert.equal(mgr.activeRunId(), null);
  db.close();
});

test("a built-in recipe run omits deps.resolveProfile so BatchRunner uses its URL-matched resolver", async () => {
  const { db, store, emit } = setup();
  const project = store.createProject({
    name: "Built-in",
    recipe: { name: "Batcave", contentType: "image", builtIn: true, builtInProfile: "batcave" },
  });
  const run = store.createRun({ projectId: project.id, label: "L" });
  store.addItems(run.id, ["https://batcave.biz/1"]);
  const factory = fakeFactory(async () => 0);
  const mgr = createRunManager({ store, emit, runnerFactory: factory, runOutDir: () => "/o" });
  assert.equal(await mgr.start(run.id), "done");
  const { deps, config } = factory.created[0];
  assert.equal("resolveProfile" in deps, false);
  assert.equal(typeof deps.createJobSource, "function");
  assert.equal(typeof deps.onItem, "function");
  assert.equal(config.imageRules, undefined);
  db.close();
});

test("a data recipe run passes a bound deps.resolveProfile", async () => {
  const { db, store, emit, makeRun } = setup();
  const run = makeRun(["https://e.com/1"]);
  const factory = fakeFactory(async () => 0);
  const mgr = createRunManager({ store, emit, runnerFactory: factory, runOutDir: () => "/o" });
  assert.equal(await mgr.start(run.id), "done");
  assert.equal(typeof factory.created[0].deps.resolveProfile, "function");
  db.close();
});
