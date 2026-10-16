import { test } from "node:test";
import assert from "node:assert/strict";
import { createHub } from "../src/hub.mjs";
import { buildApp } from "../src/app.mjs";

test("subscribe receives later emits for its runId only", () => {
  const hub = createHub();
  const a = [];
  const b = [];
  hub.subscribe("run-a", (ev) => a.push(ev));
  hub.subscribe("run-b", (ev) => b.push(ev));
  hub.emit("run-a", { type: "log", n: 1 });
  hub.emit("run-b", { type: "log", n: 2 });
  hub.emit("run-a", { type: "log", n: 3 });
  assert.deepEqual(a, [{ type: "log", n: 1 }, { type: "log", n: 3 }]);
  assert.deepEqual(b, [{ type: "log", n: 2 }]);
});

test("emit does not replay events from before subscribe", () => {
  const hub = createHub();
  hub.emit("r", { n: 1 });
  const got = [];
  hub.subscribe("r", (ev) => got.push(ev));
  hub.emit("r", { n: 2 });
  assert.deepEqual(got, [{ n: 2 }]);
});

test("unsubscribe stops delivery and updates subscriberCount", () => {
  const hub = createHub();
  const got = [];
  const unsub = hub.subscribe("r", (ev) => got.push(ev));
  assert.equal(hub.subscriberCount("r"), 1);
  hub.emit("r", { n: 1 });
  unsub();
  assert.equal(hub.subscriberCount("r"), 0);
  hub.emit("r", { n: 2 });
  assert.deepEqual(got, [{ n: 1 }]);
  unsub(); // idempotent
});

test("emit with no subscribers is a no-op", () => {
  const hub = createHub();
  assert.equal(hub.subscriberCount("nobody"), 0);
  assert.doesNotThrow(() => hub.emit("nobody", { n: 1 }));
});

test("the same fn subscribed twice is delivered to twice and unsubscribed independently", () => {
  const hub = createHub();
  let count = 0;
  const fn = () => { count += 1; };
  const u1 = hub.subscribe("r", fn);
  hub.subscribe("r", fn);
  hub.emit("r", {});
  assert.equal(count, 2);
  u1();
  hub.emit("r", {});
  assert.equal(count, 3);
});

test("a throwing subscriber is isolated: emit never throws, others still receive", () => {
  const hub = createHub();
  const got = [];
  hub.subscribe("r", () => { throw new Error("boom"); });
  hub.subscribe("r", (ev) => got.push(ev));
  assert.doesNotThrow(() => hub.emit("r", { n: 1 }));
  assert.deepEqual(got, [{ n: 1 }]);
});

test("emit is synchronous", () => {
  const hub = createHub();
  let delivered = false;
  hub.subscribe("r", () => { delivered = true; });
  const ret = hub.emit("r", {});
  assert.equal(delivered, true);
  assert.equal(ret, undefined);
});

test("a subscriber may unsubscribe itself during emit without skipping others", () => {
  const hub = createHub();
  const got = [];
  const unsub = hub.subscribe("r", () => unsub());
  hub.subscribe("r", (ev) => got.push(ev));
  hub.emit("r", { n: 1 });
  assert.deepEqual(got, [{ n: 1 }]);
});

test("buildApp exposes a hub; GET /api/ws streams hub events as JSON and unsubscribes on close", async () => {
  const app = buildApp();
  await app.listen({ port: 0, host: "127.0.0.1" });
  assert.equal(typeof app.hub.emit, "function");
  const { port } = app.server.address();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws?runId=run-1`);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  assert.equal(app.hub.subscriberCount("run-1"), 1);
  const received = new Promise((resolve) =>
    ws.addEventListener("message", (m) => resolve(m.data), { once: true }),
  );
  app.hub.emit("run-other", { type: "ignored" });
  app.hub.emit("run-1", { type: "log", msg: "hi" });
  assert.deepEqual(JSON.parse(await received), { type: "log", msg: "hi" });
  ws.close();
  for (let i = 0; i < 50 && app.hub.subscriberCount("run-1") > 0; i += 1) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(app.hub.subscriberCount("run-1"), 0);
  await app.close();
});

test("buildApp uses an injected hub", async () => {
  const hub = createHub();
  const app = buildApp({ hub });
  assert.equal(app.hub, hub);
  await app.close();
});

test("numeric and string run ids address the same channel", () => {
  const hub = createHub();
  const got = [];
  hub.subscribe("7", (ev) => got.push(ev));
  assert.equal(hub.subscriberCount(7), 1);
  hub.emit(7, { n: 1 });
  assert.deepEqual(got, [{ n: 1 }]);
});
