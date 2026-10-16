import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/app.mjs";
import { openDb } from "../src/db/db.mjs";
import { migrate } from "../src/db/migrations.mjs";
import { createStore } from "../src/db/store.mjs";

const recipe = { name: "Example", contentType: "image", match: { hosts: ["example.com"] } };

function setup() {
  const db = openDb();
  migrate(db);
  const store = createStore(db);
  const app = buildApp({ store });
  return { db, store, app };
}

async function teardown({ app, db }) {
  await app.close();
  db.close();
}

test("project CRUD happy path", async () => {
  const ctx = setup();
  const { app } = ctx;

  const created = await app.inject({
    method: "POST",
    url: "/api/projects",
    payload: { name: "P1", recipe },
  });
  assert.equal(created.statusCode, 201);
  const { project } = created.json();
  assert.equal(project.name, "P1");
  assert.deepEqual(project.recipe, recipe);
  assert.ok(Number.isInteger(project.id));

  const got = await app.inject({ method: "GET", url: `/api/projects/${project.id}` });
  assert.equal(got.statusCode, 200);
  assert.deepEqual(got.json(), { project });

  const list = await app.inject({ method: "GET", url: "/api/projects" });
  assert.equal(list.statusCode, 200);
  assert.deepEqual(list.json(), { projects: [project] });

  const updated = await app.inject({
    method: "PUT",
    url: `/api/projects/${project.id}`,
    payload: { name: "P2" },
  });
  assert.equal(updated.statusCode, 200);
  assert.equal(updated.json().project.name, "P2");
  assert.deepEqual(updated.json().project.recipe, recipe);

  const removed = await app.inject({ method: "DELETE", url: `/api/projects/${project.id}` });
  assert.equal(removed.statusCode, 204);
  assert.equal(removed.body, "");

  const gone = await app.inject({ method: "GET", url: `/api/projects/${project.id}` });
  assert.equal(gone.statusCode, 404);
  await teardown(ctx);
});

test("POST with a bad recipe returns 400 with parse error", async () => {
  const ctx = setup();
  const res = await ctx.app.inject({
    method: "POST",
    url: "/api/projects",
    payload: { name: "P1", recipe: { name: "x", contentType: "video" } },
  });
  assert.equal(res.statusCode, 400);
  assert.ok(res.json().error.issues.length > 0);
  await teardown(ctx);
});

test("POST with an empty name returns 400", async () => {
  const ctx = setup();
  const res = await ctx.app.inject({
    method: "POST",
    url: "/api/projects",
    payload: { name: "", recipe },
  });
  assert.equal(res.statusCode, 400);
  await teardown(ctx);
});

test("PUT with an invalid body returns 400", async () => {
  const ctx = setup();
  const project = ctx.store.createProject({ name: "P", recipe });
  const res = await ctx.app.inject({
    method: "PUT",
    url: `/api/projects/${project.id}`,
    payload: { recipe: { name: "x", contentType: "video" } },
  });
  assert.equal(res.statusCode, 400);
  await teardown(ctx);
});

test("unknown id returns 404 for GET, PUT and DELETE", async () => {
  const ctx = setup();
  const get = await ctx.app.inject({ method: "GET", url: "/api/projects/999" });
  assert.equal(get.statusCode, 404);
  const put = await ctx.app.inject({
    method: "PUT",
    url: "/api/projects/999",
    payload: { name: "x" },
  });
  assert.equal(put.statusCode, 404);
  const del = await ctx.app.inject({ method: "DELETE", url: "/api/projects/999" });
  assert.equal(del.statusCode, 404);
  await teardown(ctx);
});

test("non-numeric or non-positive id returns 400", async () => {
  const ctx = setup();
  for (const id of ["abc", "1.5", "0", "-1", "1abc"]) {
    const res = await ctx.app.inject({ method: "GET", url: `/api/projects/${id}` });
    assert.equal(res.statusCode, 400, `GET ${id}`);
  }
  const del = await ctx.app.inject({ method: "DELETE", url: "/api/projects/abc" });
  assert.equal(del.statusCode, 400);
  await teardown(ctx);
});

test("DELETE a project that still has runs returns 409 and keeps the run", async () => {
  const ctx = setup();
  const { project } = (
    await ctx.app.inject({ method: "POST", url: "/api/projects", payload: { name: "P1", recipe } })
  ).json();
  const run = ctx.store.createRun({ projectId: project.id, label: "r1" });

  const res = await ctx.app.inject({ method: "DELETE", url: `/api/projects/${project.id}` });
  assert.equal(res.statusCode, 409);
  assert.match(res.json().error, /run/i);

  assert.ok(ctx.store.getProject(project.id));
  assert.ok(ctx.store.getRun(run.id));
  await teardown(ctx);
});
