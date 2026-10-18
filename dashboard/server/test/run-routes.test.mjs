import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/app.mjs";
import { createHub } from "../src/hub.mjs";
import { openDb } from "../src/db/db.mjs";
import { migrate } from "../src/db/migrations.mjs";
import { createStore } from "../src/db/store.mjs";

function setup({ withManager = true } = {}) {
  const db = openDb();
  migrate(db);
  const store = createStore(db);
  const project = store.createProject({ name: "P", recipe: { name: "Img", contentType: "image" } });
  const calls = { start: [], stop: [] };
  let runningId = null;
  const runManager = {
    start(id) {
      calls.start.push(id);
      store.setRunState(id, "running");
      runningId = id;
      return new Promise(() => {}); // never settles: the route must not await it
    },
    stop(id) {
      calls.stop.push(id);
      return runningId === id;
    },
    activeRunId: () => runningId,
  };
  const app = buildApp(withManager ? { store, runManager, hub: createHub() } : { store });
  const makeRun = (state) => {
    const run = store.createRun({ projectId: project.id, label: "L" });
    if (state !== "queued") store.setRunState(run.id, state);
    return run;
  };
  return { db, store, app, calls, makeRun, setRunning: (id) => { runningId = id; } };
}

const post = (app, url) => app.inject({ method: "POST", url });

test("start a queued run: 200, manager.start called, returns the re-read run", async () => {
  const { db, app, calls, makeRun } = setup();
  const run = makeRun("queued");
  const res = await post(app, `/api/runs/${run.id}/start`);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls.start, [run.id]);
  assert.equal(res.json().run.id, run.id);
  assert.equal(res.json().run.state, "running");
  await app.close();
  db.close();
});

test("start a stopped run is allowed", async () => {
  const { db, app, calls, makeRun } = setup();
  const run = makeRun("stopped");
  assert.equal((await post(app, `/api/runs/${run.id}/start`)).statusCode, 200);
  assert.deepEqual(calls.start, [run.id]);
  await app.close();
  db.close();
});

test("start a running/done/failed run: 409 and manager.start is not called", async () => {
  const { db, app, calls, makeRun } = setup();
  for (const state of ["running", "done", "failed"]) {
    const run = makeRun(state);
    const res = await post(app, `/api/runs/${run.id}/start`);
    assert.equal(res.statusCode, 409, state);
  }
  assert.deepEqual(calls.start, []);
  await app.close();
  db.close();
});

test("stop the running run: 200 { stopped: true }", async () => {
  const { db, app, calls, makeRun, setRunning } = setup();
  const run = makeRun("running");
  setRunning(run.id);
  const res = await post(app, `/api/runs/${run.id}/stop`);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { stopped: true });
  assert.deepEqual(calls.stop, [run.id]);
  await app.close();
  db.close();
});

test("stop a run that is not running: 409", async () => {
  const { db, app, makeRun } = setup();
  const run = makeRun("queued");
  const res = await post(app, `/api/runs/${run.id}/stop`);
  assert.equal(res.statusCode, 409);
  await app.close();
  db.close();
});

test("missing run: 404 for start and stop; bad id: 400", async () => {
  const { db, app, calls } = setup();
  assert.equal((await post(app, "/api/runs/999/start")).statusCode, 404);
  assert.equal((await post(app, "/api/runs/999/stop")).statusCode, 404);
  assert.equal((await post(app, "/api/runs/abc/start")).statusCode, 400);
  assert.equal((await post(app, "/api/runs/0/stop")).statusCode, 400);
  assert.deepEqual(calls.start, []);
  assert.deepEqual(calls.stop, []);
  await app.close();
  db.close();
});

test("without a runManager the start/stop routes are absent; other routes still work", async () => {
  const { db, app, makeRun } = setup({ withManager: false });
  const run = makeRun("queued");
  assert.equal((await post(app, `/api/runs/${run.id}/start`)).statusCode, 404);
  assert.equal((await post(app, `/api/runs/${run.id}/stop`)).statusCode, 404);
  assert.equal((await app.inject({ method: "GET", url: `/api/runs/${run.id}` })).statusCode, 200);
  await app.close();
  db.close();
});

test("wiring smoke: real store + fake runManager + hub registers the start route", async () => {
  const { db, app } = setup();
  await app.ready();
  assert.ok(app.hasRoute({ method: "POST", url: "/api/runs/:id/start" }));
  assert.ok(app.hasRoute({ method: "POST", url: "/api/runs/:id/stop" }));
  assert.ok(app.hub);
  assert.ok(app.hasRoute({ method: "POST", url: "/api/runs/:id/retry" }));
  assert.ok(app.hasRoute({ method: "POST", url: "/api/runs/:id/items/:itemId/retry" }));
  await app.close();
  db.close();
});

function seedFailed(store, runId) {
  store.addItems(runId, ["https://example.com/a", "https://example.com/b", "https://example.com/c"]);
  const [a, b, c] = store.listItems(runId);
  store.setItemStatus(a.id, "retry");
  store.setItemStatus(b.id, "retry");
  store.setItemStatus(c.id, "done");
  return { a, b, c };
}

test("retry failed: resets only failed rows, queues + starts the run, returns it", async () => {
  const { db, store, app, calls, makeRun } = setup();
  const run = makeRun("done");
  const { a, b, c } = seedFailed(store, run.id);
  const res = await post(app, `/api/runs/${run.id}/retry`);
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().run.id, run.id);
  assert.deepEqual(calls.start, [run.id]);
  assert.equal(store.getItem(a.id).status, "");
  assert.equal(store.getItem(b.id).status, "");
  assert.equal(store.getItem(c.id).status, "done");
  await app.close();
  db.close();
});

test("retry failed: run is re-queued before the manager is handed it", async () => {
  const { db, store, app, makeRun } = setup();
  const run = makeRun("failed");
  seedFailed(store, run.id);
  // The fake manager flips the run to "running" on start; capture what it saw.
  let stateAtStart = null;
  const origSet = store.setRunState.bind(store);
  store.setRunState = (id, state, times) => {
    if (state === "running") stateAtStart = store.getRun(id).state;
    return origSet(id, state, times);
  };
  await post(app, `/api/runs/${run.id}/retry`);
  assert.equal(stateAtStart, "queued");
  await app.close();
  db.close();
});

test("retry one: resets just that row, queues + starts the run", async () => {
  const { db, store, app, calls, makeRun } = setup();
  const run = makeRun("done");
  const { a, b } = seedFailed(store, run.id);
  const res = await post(app, `/api/runs/${run.id}/items/${a.id}/retry`);
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().run.id, run.id);
  assert.deepEqual(calls.start, [run.id]);
  assert.equal(store.getItem(a.id).status, "");
  assert.equal(store.getItem(b.id).status, "retry"); // other failed row untouched
  await app.close();
  db.close();
});

test("retry (all / one): 409 while running, manager not called, rows untouched", async () => {
  const { db, store, app, calls, makeRun } = setup();
  const run = makeRun("running");
  const { a } = seedFailed(store, run.id);
  assert.equal((await post(app, `/api/runs/${run.id}/retry`)).statusCode, 409);
  assert.equal((await post(app, `/api/runs/${run.id}/items/${a.id}/retry`)).statusCode, 409);
  assert.deepEqual(calls.start, []);
  assert.equal(store.getItem(a.id).status, "retry");
  await app.close();
  db.close();
});

test("retry (all / one): 404 unknown run or item (incl. other run's item), 400 bad id", async () => {
  const { db, store, app, calls, makeRun } = setup();
  const run = makeRun("done");
  const other = makeRun("done");
  const { a } = seedFailed(store, run.id);
  assert.equal((await post(app, "/api/runs/999/retry")).statusCode, 404);
  assert.equal((await post(app, `/api/runs/999/items/${a.id}/retry`)).statusCode, 404);
  assert.equal((await post(app, `/api/runs/${run.id}/items/999/retry`)).statusCode, 404);
  assert.equal((await post(app, `/api/runs/${other.id}/items/${a.id}/retry`)).statusCode, 404);
  assert.equal((await post(app, `/api/runs/${run.id}/items/abc/retry`)).statusCode, 400);
  assert.deepEqual(calls.start, []);
  assert.equal(store.getItem(a.id).status, "retry");
  await app.close();
  db.close();
});
