// test/text-records.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { RecordWriter } from "../src/text/records.mjs";

async function tmp(fn) { const d = await mkdtemp(path.join(tmpdir(), "rec-")); try { return await fn(d); } finally { await rm(d, { recursive: true, force: true }); } }

test("RecordWriter: writes JSON + CSV, incremental, union columns, ; join", async () => {
  await tmp(async (dir) => {
    const w = new RecordWriter(path.join(dir, "out"));
    await w.append({ url: "https://a", email: ["x@a.com", "y@a.com"] });
    // after first append, file already exists (incremental)
    const j1 = JSON.parse(await readFile(path.join(dir, "out.json"), "utf8"));
    assert.equal(j1.length, 1);
    await w.append({ url: "https://b", phone: ["555"] });
    const j2 = JSON.parse(await readFile(path.join(dir, "out.json"), "utf8"));
    assert.equal(j2.length, 2);
    assert.deepEqual(j2[0].email, ["x@a.com", "y@a.com"]);
    const csv = await readFile(path.join(dir, "out.csv"), "utf8");
    assert.match(csv.split("\n")[0], /url/);
    assert.match(csv, /email/);
    assert.match(csv, /phone/);
    assert.match(csv, /x@a.com; y@a.com/); // array joined with "; "
    assert.equal(w.count, 2);
  });
});
