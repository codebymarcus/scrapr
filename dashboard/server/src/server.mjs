import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { buildApp } from "./app.mjs";
import { closeBrowser, getBrowser } from "./browser-pool.mjs";
import { DATA_DIR, PORT } from "./config.mjs";
import { openDb } from "./db/db.mjs";
import { migrate } from "./db/migrations.mjs";
import { createStore } from "./db/store.mjs";
import { createHub } from "./hub.mjs";
import { defaultRunOutDir } from "./routes/runs.mjs";
import { createRunManager } from "./run-manager.mjs";

// How long shutdown waits for a stopping run to settle before closing the db.
const SHUTDOWN_IDLE_TIMEOUT_MS = 10_000;

mkdirSync(DATA_DIR, { recursive: true });
const db = openDb(join(DATA_DIR, "scrapr.db"));
migrate(db);
const store = createStore(db);
const hub = createHub();
// The same dir the results route reads from.
const runOutDir = defaultRunOutDir;
// hub.emit is synchronous, as the run manager requires.
const runManager = createRunManager({
  store,
  emit: hub.emit,
  runOutDir,
  now: () => new Date().toISOString(),
});

const app = buildApp({
  store,
  runManager,
  hub,
  runOutDir,
  getBrowser,
  fetch: globalThis.fetch,
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, shutting down`);
  let code = 0;
  const step = async (fn) => {
    try {
      await fn();
    } catch (err) {
      code = 1;
      console.error(err);
    }
  };
  await step(() => app.close());
  // Stop an in-flight scrape so it can record its state before the db closes.
  await step(async () => {
    const activeId = runManager.activeRunId();
    if (activeId === null) return;
    runManager.stop(activeId);
    let timer;
    await Promise.race([
      runManager.idle(),
      new Promise((resolve) => {
        timer = setTimeout(resolve, SHUTDOWN_IDLE_TIMEOUT_MS);
      }),
    ]);
    clearTimeout(timer);
  });
  await step(() => closeBrowser());
  await step(() => db.close());
  process.exit(code);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

try {
  await app.listen({ port: PORT, host: "127.0.0.1" });
  console.log(`dashboard server listening on http://127.0.0.1:${PORT}`);
} catch (err) {
  console.error(err);
  process.exit(1);
}
