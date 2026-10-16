import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "../src/app.mjs";
import { openDb } from "../src/db/db.mjs";
import { migrate } from "../src/db/migrations.mjs";
import { createStore } from "../src/db/store.mjs";

const fixture = fileURLToPath(new URL("./fixtures/links.csv", import.meta.url));
const imageRecipe = { name: "Img", contentType: "image" };
const textRecipe = { name: "Txt", contentType: "text", text: { mode: "pattern", patterns: ["x"] } };

function setup() {
  const db = openDb();
  migrate(db);
  const store = createStore(db);
  const outRoot = mkdtempSync(join(tmpdir(), "runs-test-"));
  const app = buildApp({ store, runOutDir: (run) => join(outRoot, String(run.id)) });
  const project = store.createProject({ name: "P", recipe: imageRecipe });
  const textProject = store.createProject({ name: "T", recipe: textRecipe });
  return { db, store, app, project, textProject, outRoot };
}

async function teardown({ app, db, outRoot }) {
  await app.close();
  db.close();
  rmSync(outRoot, { recursive: true, force: true });
}

async function createRun(app, projectId) {
  const res = await app.inject({ method: "POST", url: "/api/runs", payload: { projectId, label: "L" } });
  return { res, body: res.json() };
}

test("create run bound to a project, list and get", async () => {
  const ctx = setup();
  const { app, project } = ctx;
  const { res, body } = await createRun(app, project.id);
  assert.equal(res.statusCode, 201);
  assert.equal(body.run.state, "queued");
  assert.equal(body.run.project_id, project.id);

  const list = (await app.inject({ method: "GET", url: "/api/runs" })).json();
  assert.equal(list.runs.length, 1);

  const got = await app.inject({ method: "GET", url: `/api/runs/${body.run.id}` });
  assert.equal(got.statusCode, 200);
  assert.deepEqual(got.json().items, []);
  await teardown(ctx);
});

test("create run validates body and project existence", async () => {
  const ctx = setup();
  const { app } = ctx;
  const missing = await app.inject({ method: "POST", url: "/api/runs", payload: {} });
  assert.equal(missing.statusCode, 400);
  const noProject = await app.inject({ method: "POST", url: "/api/runs", payload: { projectId: 999 } });
  assert.equal(noProject.statusCode, 404);
  await teardown(ctx);
});

test("get run: 404 for unknown, 400 for bad id", async () => {
  const ctx = setup();
  assert.equal((await ctx.app.inject({ method: "GET", url: "/api/runs/999" })).statusCode, 404);
  assert.equal((await ctx.app.inject({ method: "GET", url: "/api/runs/abc" })).statusCode, 400);
  await teardown(ctx);
});

test("enqueue into a queued run adds items", async () => {
  const ctx = setup();
  const { app, project } = ctx;
  const { body } = await createRun(app, project.id);
  const res = await app.inject({
    method: "POST",
    url: `/api/runs/${body.run.id}/items`,
    payload: { urls: ["https://example.com/1", "https://example.com/2"] },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().added, 2);
  const got = (await app.inject({ method: "GET", url: `/api/runs/${body.run.id}` })).json();
  assert.deepEqual(got.items.map((i) => i.url), ["https://example.com/1", "https://example.com/2"]);
  await teardown(ctx);
});

test("enqueue into a stopped run is allowed", async () => {
  const ctx = setup();
  const { app, store, project } = ctx;
  const { body } = await createRun(app, project.id);
  store.setRunState(body.run.id, "stopped");
  const res = await app.inject({
    method: "POST",
    url: `/api/runs/${body.run.id}/items`,
    payload: { urls: ["https://example.com/1"] },
  });
  assert.equal(res.statusCode, 200);
  await teardown(ctx);
});

test("enqueue into a running run is 409; done run is 409; missing run is 404", async () => {
  const ctx = setup();
  const { app, store, project } = ctx;
  const { body } = await createRun(app, project.id);
  const url = `/api/runs/${body.run.id}/items`;
  const payload = { urls: ["https://example.com/1"] };

  store.setRunState(body.run.id, "running");
  assert.equal((await app.inject({ method: "POST", url, payload })).statusCode, 409);
  assert.equal(store.listItems(body.run.id).length, 0);

  store.setRunState(body.run.id, "done");
  assert.equal((await app.inject({ method: "POST", url, payload })).statusCode, 409);

  assert.equal(
    (await app.inject({ method: "POST", url: "/api/runs/999/items", payload })).statusCode,
    404,
  );
  const emptyList = await app.inject({ method: "POST", url: `/api/runs/${body.run.id}/items`, payload: { urls: [] } });
  assert.equal(emptyList.statusCode, 400);
  const bad = await app.inject({ method: "POST", url: `/api/runs/${body.run.id}/items`, payload: { urls: ["ftp://x"] } });
  assert.equal(bad.statusCode, 400);
  await teardown(ctx);
});

test("import parses a sheet by path and returns urls", async () => {
  const ctx = setup();
  const res = await ctx.app.inject({ method: "POST", url: "/api/runs/import", payload: { path: fixture } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().urls, ["https://example.com/a", "https://example.com/b"]);
  await teardown(ctx);
});

test("import with runId enqueues the urls", async () => {
  const ctx = setup();
  const { app, project } = ctx;
  const { body } = await createRun(app, project.id);
  const res = await app.inject({
    method: "POST",
    url: "/api/runs/import",
    payload: { path: fixture, runId: body.run.id },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().added, 2);
  assert.equal(ctx.store.listItems(body.run.id).length, 2);

  ctx.store.setRunState(body.run.id, "running");
  const conflict = await app.inject({
    method: "POST",
    url: "/api/runs/import",
    payload: { path: fixture, runId: body.run.id },
  });
  assert.equal(conflict.statusCode, 409);
  await teardown(ctx);
});

test("import validates path and file", async () => {
  const ctx = setup();
  const { app } = ctx;
  assert.equal((await app.inject({ method: "POST", url: "/api/runs/import", payload: {} })).statusCode, 400);
  assert.equal(
    (await app.inject({ method: "POST", url: "/api/runs/import", payload: { path: "/nope/x.csv" } })).statusCode,
    400,
  );
  assert.equal(
    (await app.inject({ method: "POST", url: "/api/runs/import", payload: { path: "/etc/hosts" } })).statusCode,
    400,
  );
  await teardown(ctx);
});

test("text results: records when file exists, empty when absent", async () => {
  const ctx = setup();
  const { app, textProject, outRoot } = ctx;
  const { body } = await createRun(app, textProject.id);
  const id = body.run.id;

  const empty = await app.inject({ method: "GET", url: `/api/runs/${id}/results` });
  assert.equal(empty.statusCode, 200);
  assert.deepEqual(empty.json(), { contentType: "text", records: [] });

  // The engine's RecordWriter writes `${outDir}.json` (a sibling of the run dir).
  mkdirSync(outRoot, { recursive: true });
  writeFileSync(`${join(outRoot, String(id))}.json`, JSON.stringify([{ url: "https://example.com/a", title: "A" }]));
  const full = await app.inject({ method: "GET", url: `/api/runs/${id}/results` });
  assert.deepEqual(full.json().records, [{ url: "https://example.com/a", title: "A" }]);

  writeFileSync(`${join(outRoot, String(id))}.json`, "{not json");
  const corrupt = await app.inject({ method: "GET", url: `/api/runs/${id}/results` });
  assert.equal(corrupt.statusCode, 200);
  assert.deepEqual(corrupt.json().records, []);
  await teardown(ctx);
});

test("image results: outputs listing, empty when none", async () => {
  const ctx = setup();
  const { app, project, outRoot } = ctx;
  const { body } = await createRun(app, project.id);
  const id = body.run.id;

  const empty = await app.inject({ method: "GET", url: `/api/runs/${id}/results` });
  assert.deepEqual(empty.json(), { contentType: "image", outputs: [] });

  mkdirSync(join(outRoot, String(id)), { recursive: true });
  writeFileSync(join(outRoot, String(id), "chapter-1.cbz"), "x");
  const full = await app.inject({ method: "GET", url: `/api/runs/${id}/results` });
  assert.deepEqual(full.json().outputs, [{ name: "chapter-1.cbz", size: 1 }]);

  assert.equal((await app.inject({ method: "GET", url: "/api/runs/999/results" })).statusCode, 404);
  await teardown(ctx);
});
