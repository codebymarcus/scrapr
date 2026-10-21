// Global row-slot semaphore: caps the TOTAL number of rows scraping at once
// across all runs. A counting semaphore with a FIFO waiter queue; acquire()
// resolves with a release fn immediately while inUse < max, else queues.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRowLimiter } from "../src/row-limiter.mjs";

test("limiter never lets more than max run at once; releases unblock the queue", async () => {
  const lim = createRowLimiter(2);
  const rel = [await lim.acquire(), await lim.acquire()];
  assert.equal(lim.inUse(), 2);
  let third = false;
  lim.acquire().then((r) => { third = true; r(); });
  await Promise.resolve();
  assert.equal(third, false); // blocked at the cap
  rel[0]();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(third, true);
});

test("double-release is safe: it does not over-credit the semaphore", async () => {
  const lim = createRowLimiter(1);
  const rel = await lim.acquire();
  assert.equal(lim.inUse(), 1);
  // A second acquire must block (only one slot).
  let second = false;
  const p = lim.acquire().then((r) => { second = true; return r; });
  await Promise.resolve();
  assert.equal(second, false);
  // Releasing twice must free exactly ONE slot, not two.
  rel();
  rel();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(second, true, "the one waiter is admitted");
  const r2 = await p;
  // After the waiter is admitted, inUse is back at the cap and a further acquire blocks.
  assert.equal(lim.inUse(), 1, "double-release did not credit an extra slot");
  let third = false;
  lim.acquire().then((r) => { third = true; r(); });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(third, false, "no phantom slot was opened by the double-release");
  r2();
});

test("waiters are admitted FIFO as slots free", async () => {
  const lim = createRowLimiter(1);
  const held = await lim.acquire();
  const order = [];
  lim.acquire().then((r) => { order.push("a"); r(); });
  lim.acquire().then((r) => { order.push("b"); r(); });
  lim.acquire().then((r) => { order.push("c"); r(); });
  held();
  // drain the queue
  for (let i = 0; i < 12; i++) await Promise.resolve();
  assert.deepEqual(order, ["a", "b", "c"]);
});

test("max<1 is clamped so acquire still resolves (never deadlocks)", async () => {
  const lim = createRowLimiter(0);
  const rel = await lim.acquire();
  assert.equal(lim.inUse(), 1);
  rel();
  assert.equal(lim.inUse(), 0);
});
