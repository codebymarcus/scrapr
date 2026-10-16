import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db/db.mjs";
import { migrate } from "../src/db/migrations.mjs";
import { createStore } from "../src/db/store.mjs";

function setup() {
  const db = openDb();
  migrate(db);
  return { db, store: createStore(db) };
}

test("project create -> get -> list -> update -> delete", () => {
  const { db, store } = setup();
  const recipe = { steps: [{ type: "open", url: "https://x" }] };
  const created = store.createProject({ name: "P1", recipe });
  assert.equal(created.name, "P1");
  assert.deepEqual(created.recipe, recipe);
  assert.ok(created.created_at);
  assert.ok(created.updated_at);

  assert.deepEqual(store.getProject(created.id), created);
  assert.equal(store.getProject(9999), null);
  assert.equal(store.listProjects().length, 1);

  const updated = store.updateProject(created.id, { name: "P2", recipe: { steps: [] } });
  assert.equal(updated.name, "P2");
  assert.deepEqual(updated.recipe, { steps: [] });
  assert.ok(updated.updated_at >= created.updated_at);

  const nameOnly = store.updateProject(created.id, { name: "P3" });
  assert.equal(nameOnly.name, "P3");
  assert.deepEqual(nameOnly.recipe, { steps: [] });

  store.deleteProject(created.id);
  assert.equal(store.getProject(created.id), null);
  assert.deepEqual(store.listProjects(), []);
  db.close();
});

test("createRun starts queued; getRun/listRuns/setRunState", () => {
  const { db, store } = setup();
  const p = store.createProject({ name: "P", recipe: {} });
  const run = store.createRun({ projectId: p.id, label: "first" });
  assert.equal(run.state, "queued");
  assert.equal(run.label, "first");
  assert.equal(run.project_id, p.id);
  assert.ok(run.created_at);
  assert.equal(store.getRun(9999), null);
  assert.equal(store.listRuns().length, 1);

  store.setRunState(run.id, "running", { startedAt: "2026-01-01T00:00:00.000Z" });
  let r = store.getRun(run.id);
  assert.equal(r.state, "running");
  assert.equal(r.started_at, "2026-01-01T00:00:00.000Z");
  assert.equal(r.finished_at, null);

  store.setRunState(run.id, "done", { finishedAt: "2026-01-01T01:00:00.000Z" });
  r = store.getRun(run.id);
  assert.equal(r.state, "done");
  assert.equal(r.started_at, "2026-01-01T00:00:00.000Z");
  assert.equal(r.finished_at, "2026-01-01T01:00:00.000Z");
  db.close();
});

test("addItems assigns increasing positions; loadItems returns job-source shape", () => {
  const { db, store } = setup();
  const p = store.createProject({ name: "P", recipe: {} });
  const run = store.createRun({ projectId: p.id, label: "r" });
  store.addItems(run.id, ["https://a", "https://b"]);
  store.addItems(run.id, ["https://c"]);

  const items = store.loadItems(run.id);
  assert.deepEqual(
    items.map((i) => i.url),
    ["https://a", "https://b", "https://c"],
  );
  for (const i of items) {
    assert.deepEqual(Object.keys(i).sort(), ["id", "name", "status", "url"]);
    assert.equal(i.status, "");
  }
  const positions = store.listItems(run.id).map((i) => i.position);
  assert.deepEqual(positions, [0, 1, 2]);
  db.close();
});

test("setItemStatus and setItemReason persist synchronously", () => {
  const { db, store } = setup();
  const p = store.createProject({ name: "P", recipe: {} });
  const run = store.createRun({ projectId: p.id, label: "r" });
  store.addItems(run.id, ["https://a"]);
  const [item] = store.loadItems(run.id);

  store.setItemStatus(item.id, "Done");
  assert.equal(store.loadItems(run.id)[0].status, "Done");

  store.setItemReason(item.id, "No hero image");
  assert.equal(store.listItems(run.id)[0].reason, "No hero image");
  db.close();
});

test("setItemResult stores saved/total and needs_review as 0/1", () => {
  const { db, store } = setup();
  const p = store.createProject({ name: "P", recipe: {} });
  const run = store.createRun({ projectId: p.id, label: "r" });
  store.addItems(run.id, ["https://a", "https://b"]);
  const [a, b] = store.listItems(run.id);

  store.setItemResult(a.id, { saved: 3, total: 5, needsReview: true });
  store.setItemResult(b.id, { saved: 5, total: 5, needsReview: false });
  const [ra, rb] = store.listItems(run.id);
  assert.equal(ra.saved, 3);
  assert.equal(ra.total, 5);
  assert.equal(ra.needs_review, 1);
  assert.equal(rb.needs_review, 0);
  db.close();
});

test("nextQueuedRun returns the oldest queued run or null", () => {
  const { db, store } = setup();
  assert.equal(store.nextQueuedRun(), null);
  const p = store.createProject({ name: "P", recipe: {} });
  const r1 = store.createRun({ projectId: p.id, label: "1" });
  const r2 = store.createRun({ projectId: p.id, label: "2" });
  assert.equal(store.nextQueuedRun().id, r1.id);
  store.setRunState(r1.id, "running");
  assert.equal(store.nextQueuedRun().id, r2.id);
  store.setRunState(r2.id, "done");
  assert.equal(store.nextQueuedRun(), null);
  db.close();
});
