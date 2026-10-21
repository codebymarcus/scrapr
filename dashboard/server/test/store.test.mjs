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

test("createRun persists overrides; getRun/listRuns/nextQueuedRun parse them; absent is null", () => {
  const { db, store } = setup();
  const p = store.createProject({ name: "P", recipe: {} });
  const overrides = { drive: true, driveFolder: "ID", driveSubfolder: "sub" };
  const withOv = store.createRun({ projectId: p.id, label: "a", overrides });
  const without = store.createRun({ projectId: p.id, label: "b" });
  assert.deepEqual(withOv.overrides, overrides);
  assert.deepEqual(store.getRun(withOv.id).overrides, overrides);
  assert.equal(store.getRun(without.id).overrides, null);
  const listed = store.listRuns();
  assert.deepEqual(listed[0].overrides, overrides);
  assert.equal(listed[1].overrides, null);
  assert.equal("overrides_json" in store.getRun(withOv.id), false);
  assert.deepEqual(store.nextQueuedRun().overrides, overrides);
  db.close();
});

test("secrets: set/get round-trips, unknown is null, set upserts, delete removes", () => {
  const { db, store } = setup();
  assert.equal(store.getSecret("drive.token"), null);
  store.setSecret("drive.token", "v1:opaque-blob");
  assert.equal(store.getSecret("drive.token"), "v1:opaque-blob");
  store.setSecret("drive.token", "v1:second");
  assert.equal(store.getSecret("drive.token"), "v1:second");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM secrets").get().n, 1);
  store.deleteSecret("drive.token");
  assert.equal(store.getSecret("drive.token"), null);
  db.close();
});

test("failInterruptedRuns marks running runs failed, leaves others", () => {
  const { store } = setup();
  const project = store.createProject({ name: "P", recipe: {} });
  const running = store.createRun({ projectId: project.id });
  store.setRunState(running.id, "running");
  const queued = store.createRun({ projectId: project.id });
  const done = store.createRun({ projectId: project.id });
  store.setRunState(done.id, "done");

  const count = store.failInterruptedRuns();
  assert.equal(count, 1);
  assert.equal(store.getRun(running.id).state, "failed");
  assert.ok(store.getRun(running.id).finished_at);
  assert.equal(store.getRun(queued.id).state, "queued");
  assert.equal(store.getRun(done.id).state, "done");

  assert.equal(store.failInterruptedRuns(), 0); // idempotent: none left running
});

test("addItems stores a name from { url, name } rows; strings get a null name", () => {
  const { store } = setup();
  const p = store.createProject({ name: "P", recipe: {} });
  const run = store.createRun({ projectId: p.id });
  store.addItems(run.id, [
    { url: "https://a", name: "Alpha" },
    { url: "https://b", name: null },
    "https://c",
  ]);
  const items = store.loadItems(run.id);
  assert.deepEqual(
    items.map((i) => [i.url, i.name]),
    [["https://a", "Alpha"], ["https://b", null], ["https://c", null]],
  );
});

function itemsSetup(urls) {
  const { store } = setup();
  const p = store.createProject({ name: "P", recipe: {} });
  const run = store.createRun({ projectId: p.id });
  store.addItems(run.id, urls);
  return { store, run, items: store.listItems(run.id) };
}

test("setItemResult persists outputName when given and leaves it alone when omitted", () => {
  const { store, run, items } = itemsSetup(["https://a"]);
  store.setItemResult(items[0].id, { saved: 2, total: 3, needsReview: false, outputName: "alpha" });
  let row = store.listItems(run.id)[0];
  assert.equal(row.output_name, "alpha");
  assert.equal(row.saved, 2);
  store.setItemResult(items[0].id, { saved: 3, total: 3, needsReview: true });
  row = store.listItems(run.id)[0];
  assert.equal(row.output_name, "alpha");
  assert.equal(row.saved, 3);
  assert.equal(row.needs_review, 1);
});

test("setItemUpload sets uploaded_at and drive_link", () => {
  const { store, items } = itemsSetup(["https://a"]);
  assert.equal(store.getItem(items[0].id).uploaded_at, null);
  store.setItemUpload(items[0].id, { uploadedAt: "2026-01-01T00:00:00.000Z", driveLink: "https://drive/x" });
  const row = store.getItem(items[0].id);
  assert.equal(row.uploaded_at, "2026-01-01T00:00:00.000Z");
  assert.equal(row.drive_link, "https://drive/x");
});

test("getItem returns the full row incl. new columns, or null", () => {
  const { store, run, items } = itemsSetup([{ url: "https://a", name: "Alpha" }]);
  store.setItemStatus(items[0].id, "done");
  store.setItemResult(items[0].id, { saved: 1, total: 1, needsReview: false, outputName: "alpha" });
  const row = store.getItem(items[0].id);
  assert.equal(row.run_id, run.id);
  assert.equal(row.url, "https://a");
  assert.equal(row.name, "Alpha");
  assert.equal(row.status, "done");
  assert.equal(row.saved, 1);
  assert.equal(row.output_name, "alpha");
  assert.equal(row.uploaded_at, null);
  assert.equal(row.drive_link, null);
  assert.equal(store.getItem(9999), null);
});

test("deleteItem removes one item and leaves the others", () => {
  const { store, run, items } = itemsSetup(["https://a", "https://b"]);
  store.deleteItem(items[0].id);
  assert.equal(store.getItem(items[0].id), null);
  assert.deepEqual(store.listItems(run.id).map((i) => i.url), ["https://b"]);
});

test("resetItemsForRetry({ itemId }) resets just that row", () => {
  const { store, items } = itemsSetup(["https://a", "https://b"]);
  for (const it of items) {
    store.setItemStatus(it.id, "retry");
    store.setItemReason(it.id, "boom");
    store.setItemResult(it.id, { saved: 1, total: 2, needsReview: false });
    store.setItemUpload(it.id, { uploadedAt: "t", driveLink: "l" });
  }
  store.resetItemsForRetry(items[0].run_id, { itemId: items[0].id });
  const a = store.getItem(items[0].id);
  assert.equal(a.status, "");
  assert.equal(a.reason, null);
  assert.equal(a.saved, null);
  assert.equal(a.uploaded_at, null);
  assert.equal(a.drive_link, null);
  const b = store.getItem(items[1].id);
  assert.equal(b.status, "retry");
  assert.equal(b.reason, "boom");
  assert.equal(b.saved, 1);
  assert.equal(b.drive_link, "l");
});

test("resetItemsForRetry(runId) resets failed rows and leaves done/skip untouched", () => {
  const { store, run, items } = itemsSetup(["https://a", "https://b", "https://c", "https://d"]);
  const [failed, done, skip, blank] = items;
  store.setItemStatus(failed.id, "retry");
  store.setItemReason(failed.id, "boom");
  store.setItemStatus(done.id, "done");
  store.setItemResult(done.id, { saved: 2, total: 2, needsReview: false });
  store.setItemUpload(done.id, { uploadedAt: "t", driveLink: "l" });
  store.setItemStatus(skip.id, "skip");
  store.resetItemsForRetry(run.id);
  assert.equal(store.getItem(failed.id).status, "");
  assert.equal(store.getItem(failed.id).reason, null);
  assert.equal(store.getItem(done.id).status, "done");
  assert.equal(store.getItem(done.id).saved, 2);
  assert.equal(store.getItem(done.id).drive_link, "l");
  assert.equal(store.getItem(skip.id).status, "skip");
  assert.equal(store.getItem(blank.id).status, "");
});

test("setItemResult persists bytes when given and leaves it alone when omitted", () => {
  const { store, items } = itemsSetup(["https://a"]);
  assert.equal(store.getItem(items[0].id).bytes, null);
  store.setItemResult(items[0].id, { saved: 2, total: 3, needsReview: false, bytes: 12345 });
  assert.equal(store.getItem(items[0].id).bytes, 12345);
  store.setItemResult(items[0].id, { saved: 3, total: 3, needsReview: false });
  assert.equal(store.getItem(items[0].id).bytes, 12345);
});

test("setItemUpload persists output_size when given and leaves it alone when omitted", () => {
  const { store, items } = itemsSetup(["https://a"]);
  assert.equal(store.getItem(items[0].id).output_size, null);
  store.setItemUpload(items[0].id, { uploadedAt: "t", driveLink: "l", outputSize: 999 });
  assert.equal(store.getItem(items[0].id).output_size, 999);
  store.setItemUpload(items[0].id, { uploadedAt: "t2", driveLink: "l2" });
  assert.equal(store.getItem(items[0].id).output_size, 999);
});

test("drive accounts: list returns inserted accounts ordered by created_at then id", () => {
  const { db, store } = setup();
  assert.deepEqual(store.listDriveAccounts(), []);
  store.upsertDriveAccount({ id: "b", sub: "s2", label: "Second", email: "b@x.com", token: "tok-b" });
  store.upsertDriveAccount({ id: "a", sub: "s1", label: "First", email: "a@x.com", token: "tok-a" });
  const rows = store.listDriveAccounts();
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.id).sort(), ["a", "b"]);
  assert.ok(rows.every((r) => r.created_at));
  db.close();
});

test("drive accounts: get by id and by sub", () => {
  const { db, store } = setup();
  store.upsertDriveAccount({ id: "a", sub: "s1", label: "First", email: "a@x.com", token: "tok-a" });
  store.upsertDriveAccount({ id: "b", sub: "s2", label: "Second", email: "b@x.com", token: "tok-b" });
  assert.equal(store.getDriveAccount("a").email, "a@x.com");
  assert.equal(store.getDriveAccountBySub("s2").id, "b");
  assert.equal(store.getDriveAccount("nope"), null);
  assert.equal(store.getDriveAccountBySub("nope"), null);
  db.close();
});

test("drive accounts: upsert with an existing id updates in place", () => {
  const { db, store } = setup();
  store.upsertDriveAccount({ id: "a", sub: "s1", label: "First", email: "a@x.com", token: "tok-a" });
  const before = store.getDriveAccount("a");
  store.upsertDriveAccount({ id: "a", sub: "s9", label: "Renamed", email: "new@x.com", token: "tok-new" });
  const rows = store.listDriveAccounts();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sub, "s9");
  assert.equal(rows[0].label, "Renamed");
  assert.equal(rows[0].email, "new@x.com");
  assert.equal(rows[0].token, "tok-new");
  assert.equal(rows[0].created_at, before.created_at);
  db.close();
});

test("drive accounts: updateDriveAccountToken changes only token, sub and email", () => {
  const { db, store } = setup();
  store.upsertDriveAccount({ id: "a", sub: "s1", label: "First", email: "a@x.com", token: "tok-a" });
  store.updateDriveAccountToken("a", { token: "tok-2" });
  let row = store.getDriveAccount("a");
  assert.equal(row.token, "tok-2");
  assert.equal(row.sub, "s1");
  assert.equal(row.email, "a@x.com");
  assert.equal(row.label, "First");
  store.updateDriveAccountToken("a", { token: "tok-3", sub: "s2", email: "z@x.com" });
  row = store.getDriveAccount("a");
  assert.equal(row.token, "tok-3");
  assert.equal(row.sub, "s2");
  assert.equal(row.email, "z@x.com");
  assert.equal(row.label, "First");
  db.close();
});

test("drive accounts: renameDriveAccount changes only the label", () => {
  const { db, store } = setup();
  store.upsertDriveAccount({ id: "a", sub: "s1", label: "First", email: "a@x.com", token: "tok-a" });
  store.renameDriveAccount("a", "Work");
  const row = store.getDriveAccount("a");
  assert.equal(row.label, "Work");
  assert.equal(row.token, "tok-a");
  assert.equal(row.sub, "s1");
  assert.equal(row.email, "a@x.com");
  db.close();
});

test("drive accounts: deleteDriveAccount removes one and leaves the other", () => {
  const { db, store } = setup();
  store.upsertDriveAccount({ id: "a", sub: "s1", label: "First", email: "a@x.com", token: "tok-a" });
  store.upsertDriveAccount({ id: "b", sub: "s2", label: "Second", email: "b@x.com", token: "tok-b" });
  store.deleteDriveAccount("a");
  assert.equal(store.getDriveAccount("a"), null);
  assert.equal(store.listDriveAccounts().length, 1);
  assert.equal(store.getDriveAccount("b").label, "Second");
  db.close();
});
