import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db/db.mjs";
import { migrate } from "../src/db/migrations.mjs";

function tableNames(db) {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((r) => r.name);
}

test("migrate creates all tables", () => {
  const db = openDb();
  migrate(db);
  const names = tableNames(db);
  for (const t of ["_migrations", "projects", "runs", "run_items"]) {
    assert.ok(names.includes(t), `missing table ${t}`);
  }
  db.close();
});

test("migrate twice is a no-op", () => {
  const db = openDb();
  migrate(db);
  const before = db.prepare("SELECT id, applied_at FROM _migrations ORDER BY id").all();
  assert.ok(before.length > 0);
  migrate(db);
  const after = db.prepare("SELECT id, applied_at FROM _migrations ORDER BY id").all();
  assert.deepEqual(after, before);
  db.close();
});

test("foreign keys are enforced on run_items.run_id", () => {
  const db = openDb();
  migrate(db);
  assert.throws(() =>
    db.prepare("INSERT INTO run_items (run_id, url) VALUES (?, ?)").run(999, "https://x"),
  );
  db.close();
});

test("runs.state is constrained to known values", () => {
  const db = openDb();
  migrate(db);
  assert.throws(() =>
    db.prepare("INSERT INTO runs (state) VALUES (?)").run("bogus"),
  );
  db.close();
});
