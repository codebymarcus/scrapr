import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "../src/app.mjs";
import { openDb } from "../src/db/db.mjs";
import { migrate } from "../src/db/migrations.mjs";
import { createStore } from "../src/db/store.mjs";

const fixture = fileURLToPath(new URL("./fixtures/links.csv", import.meta.url));
const fixtureCsv = readFileSync(fixture, "utf8");

// Build a multipart/form-data body for app.inject. `fields` maps a name to a
// string, or to { filename, content, type? } for the uploaded file.
function multipart(fields) {
  const boundary = `----scraprtest${Math.random().toString(16).slice(2)}`;
  const parts = [];
  for (const [name, value] of Object.entries(fields)) {
    if (value && typeof value === "object" && "filename" in value) {
      parts.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${value.filename}"\r\n` +
            `Content-Type: ${value.type ?? "application/octet-stream"}\r\n\r\n`,
        ),
        Buffer.isBuffer(value.content) ? value.content : Buffer.from(value.content),
        Buffer.from("\r\n"),
      );
    } else {
      parts.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
        ),
      );
    }
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(parts),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}

const csvUpload = (extra = {}) =>
  multipart({ file: { filename: "links.csv", content: fixtureCsv, type: "text/csv" }, ...extra });
const imageRecipe = { name: "Img", contentType: "image" };
const textRecipe = { name: "Txt", contentType: "text", text: { mode: "pattern", patterns: ["x"] } };

function setup(extraDeps = {}) {
  const db = openDb();
  migrate(db);
  const store = createStore(db);
  const outRoot = mkdtempSync(join(tmpdir(), "runs-test-"));
  const app = buildApp({ store, runOutDir: (run) => join(outRoot, String(run.id)), ...extraDeps });
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

test("create run with overrides persists them and rejects invalid ones", async () => {
  const ctx = setup();
  const { app, project, store } = ctx;
  const overrides = { drive: true, driveFolder: "ID", driveSubfolder: "sub" };
  const res = await app.inject({ method: "POST", url: "/api/runs", payload: { projectId: project.id, overrides } });
  assert.equal(res.statusCode, 201);
  assert.deepEqual(res.json().run.overrides, overrides);
  assert.deepEqual(store.getRun(res.json().run.id).overrides, overrides);

  const plain = await createRun(app, project.id);
  assert.equal(plain.body.run.overrides, null);

  const bad = await app.inject({ method: "POST", url: "/api/runs", payload: { projectId: project.id, overrides: { drive: "yes" } } });
  assert.equal(bad.statusCode, 400);
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

test("import parses an uploaded sheet and returns urls", async () => {
  const ctx = setup();
  const res = await ctx.app.inject({ method: "POST", url: "/api/runs/import", ...csvUpload() });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().urls, ["https://example.com/a", "https://example.com/b"]);
  await teardown(ctx);
});

test("import with runId enqueues the uploaded urls", async () => {
  const ctx = setup();
  const { app, project } = ctx;
  const { body } = await createRun(app, project.id);
  const res = await app.inject({
    method: "POST",
    url: "/api/runs/import",
    ...csvUpload({ runId: String(body.run.id) }),
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().added, 2);
  const items = ctx.store.listItems(body.run.id);
  assert.equal(items.length, 2);
  // The sheet's name column is captured so outputs can be named from it.
  assert.deepEqual(items.map((i) => i.name), ["Alpha", "Beta"]);

  ctx.store.setRunState(body.run.id, "running");
  const conflict = await app.inject({
    method: "POST",
    url: "/api/runs/import",
    ...csvUpload({ runId: String(body.run.id) }),
  });
  assert.equal(conflict.statusCode, 409);
  await teardown(ctx);
});

test("import validates the upload (missing file, bad type, size cap)", async () => {
  const ctx = setup();
  const { app } = ctx;
  // No file part.
  assert.equal(
    (await app.inject({ method: "POST", url: "/api/runs/import", ...multipart({ runId: "1" }) })).statusCode,
    400,
  );
  // Unsupported extension.
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/runs/import",
        ...multipart({ file: { filename: "evil.png", content: "x", type: "image/png" } }),
      })
    ).statusCode,
    400,
  );
  await teardown(ctx);
});

test("import honors runId even when the field follows a large file part", async () => {
  // inject delivers the body in one chunk, so this ordering bug only shows over
  // a real socket: the file part precedes runId and is large enough to be
  // chunked, so a naive read of fields-after-request.file() would miss runId.
  const ctx = setup();
  const { app, store, project } = ctx;
  const { body } = await createRun(app, project.id);
  const lines = Array.from({ length: 4000 }, (_, i) => `https://example.com/page-${i}`);
  const bigCsv = `url\n${lines.join("\n")}\n`;

  await app.listen({ port: 0, host: "127.0.0.1" });
  try {
    const { port } = app.server.address();
    const form = new FormData();
    form.append("file", new Blob([bigCsv], { type: "text/csv" }), "big.csv");
    form.append("runId", String(body.run.id)); // deliberately AFTER the file
    const res = await fetch(`http://127.0.0.1:${port}/api/runs/import`, {
      method: "POST",
      body: form,
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).added, lines.length);
    assert.equal(store.listItems(body.run.id).length, lines.length);
  } finally {
    await teardown(ctx);
  }
});

test("import rejects an oversized upload with 413", async () => {
  const ctx = setup({ uploadMaxBytes: 32 });
  const big = `url\n${"https://example.com/".repeat(20)}\n`;
  const res = await ctx.app.inject({
    method: "POST",
    url: "/api/runs/import",
    ...multipart({ file: { filename: "big.csv", content: big, type: "text/csv" } }),
  });
  assert.equal(res.statusCode, 413);
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

test("delete run: removes the run, its items, and its output dir", async () => {
  const ctx = setup();
  const { app, project, store, outRoot } = ctx;
  const { body } = await createRun(app, project.id);
  const id = body.run.id;
  await app.inject({ method: "POST", url: `/api/runs/${id}/items`, payload: { urls: ["https://example.com/a"] } });
  mkdirSync(join(outRoot, String(id)), { recursive: true });
  writeFileSync(join(outRoot, String(id), "chapter-1.cbz"), "x");

  const del = await app.inject({ method: "DELETE", url: `/api/runs/${id}` });
  assert.equal(del.statusCode, 200);
  assert.deepEqual(del.json(), { deleted: true });

  assert.equal(store.getRun(id), null);
  assert.deepEqual(store.listItems(id), []);
  assert.equal(existsSync(join(outRoot, String(id))), false);
  assert.equal((await app.inject({ method: "GET", url: "/api/runs" })).json().runs.length, 0);
  await teardown(ctx);
});

test("delete run: 409 while running, 404 unknown, 400 bad id", async () => {
  const ctx = setup();
  const { app, project, store } = ctx;
  const { body } = await createRun(app, project.id);
  const id = body.run.id;
  store.setRunState(id, "running");

  const running = await app.inject({ method: "DELETE", url: `/api/runs/${id}` });
  assert.equal(running.statusCode, 409);
  assert.ok(store.getRun(id)); // not deleted

  assert.equal((await app.inject({ method: "DELETE", url: "/api/runs/999" })).statusCode, 404);
  assert.equal((await app.inject({ method: "DELETE", url: "/api/runs/abc" })).statusCode, 400);
  await teardown(ctx);
});
