import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeRun } from "../src/run-summary.mjs";
import { DEFAULTS } from "../../../src/config.mjs";

const item = (over) => ({ status: "", reason: null, saved: null, uploaded_at: null, output_size: null, bytes: null, ...over });

test("summarizeRun aggregates counts, pages, sizes, bytes, duration and cost", () => {
  const run = { started_at: "2026-01-01T00:00:00.000Z", finished_at: "2026-01-01T00:01:30.500Z" };
  const items = [
    item({ status: "done", saved: 10, bytes: 2_000_000_000, uploaded_at: "t", output_size: 500 }),
    item({ status: "done", saved: 5, bytes: 1_000_000_000, output_size: 77 }), // not uploaded: size ignored
    item({ status: "retry", reason: "boom", bytes: 500_000_000 }),
    item({ status: "skip" }),
    item({ reason: "skipped: already done" }),
    item({ reason: "timeout" }),
    item({}),
  ];
  const s = summarizeRun(run, items, { costPerGb: 2 });
  assert.equal(s.durationMs, 90_500);
  assert.deepEqual(s.counts, { total: 7, completed: 2, failed: 2, skipped: 2, uploaded: 1 });
  assert.equal(s.pages, 15);
  assert.equal(s.uploadedSize, 500);
  assert.equal(s.bytesDownloaded, 3_500_000_000);
  assert.equal(s.cost, 7);
});

test("summarizeRun uses DEFAULTS.costPerGb by default", () => {
  const s = summarizeRun({}, [item({ bytes: 1e9 })]);
  assert.equal(s.cost, (1e9 / 1e9) * (DEFAULTS.costPerGb ?? 0));
});

test("summarizeRun has a null duration when started_at or finished_at is missing", () => {
  assert.equal(summarizeRun({ started_at: "2026-01-01T00:00:00.000Z", finished_at: null }, []).durationMs, null);
  assert.equal(summarizeRun({ started_at: null, finished_at: "2026-01-01T00:00:00.000Z" }, []).durationMs, null);
  assert.equal(summarizeRun({ started_at: "garbage", finished_at: "2026-01-01T00:00:00.000Z" }, []).durationMs, null);
});

test("summarizeRun is null-safe on an empty run", () => {
  assert.deepEqual(summarizeRun({}, [], { costPerGb: 1 }), {
    durationMs: null,
    counts: { total: 0, completed: 0, failed: 0, skipped: 0, uploaded: 0 },
    pages: 0,
    uploadedSize: 0,
    bytesDownloaded: 0,
    cost: 0,
  });
});
