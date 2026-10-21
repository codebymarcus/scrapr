// Must be first: loads dashboard/server/.env before config.mjs reads process.env.
import "./load-env.mjs";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { buildApp } from "./app.mjs";
import { closeBrowser, getBrowser } from "./browser-pool.mjs";
import {
  APP_SECRET_KEY,
  DATA_DIR,
  GOOGLE_OAUTH_CLIENT_ID,
  GOOGLE_OAUTH_CLIENT_SECRET,
  GOOGLE_OAUTH_REDIRECT_URI,
  HOST,
  PORT,
} from "./config.mjs";
import { openDb } from "./db/db.mjs";
import { migrate } from "./db/migrations.mjs";
import { createStore } from "./db/store.mjs";
import { createDriveAuth } from "./drive-auth.mjs";
import { createHub } from "./hub.mjs";
import { defaultRunOutDir } from "./routes/runs.mjs";
import { createRunManager } from "./run-manager.mjs";
import { stopActiveRuns } from "./stop-active-runs.mjs";

// How long shutdown waits for a stopping run to settle before closing the db.
const SHUTDOWN_IDLE_TIMEOUT_MS = 10_000;

mkdirSync(DATA_DIR, { recursive: true });
const db = openDb(join(DATA_DIR, "scrapr.db"));
migrate(db);
const store = createStore(db);
// Crash/restart recovery: no scrape survives a server exit, so any run still
// marked "running" is orphaned: reconcile it to "failed" so it's not stuck.
const interrupted = store.failInterruptedRuns();
if (interrupted > 0) {
  console.log(`reconciled ${interrupted} interrupted run(s) to failed`);
}
const hub = createHub();
// Boots fine without the OAuth env/key; Drive then reports "not-configured".
const driveAuth = createDriveAuth({
  store,
  key: APP_SECRET_KEY,
  clientId: GOOGLE_OAUTH_CLIENT_ID,
  clientSecret: GOOGLE_OAUTH_CLIENT_SECRET,
  redirectUri: GOOGLE_OAUTH_REDIRECT_URI,
});
if (
  GOOGLE_OAUTH_CLIENT_ID &&
  GOOGLE_OAUTH_CLIENT_SECRET &&
  HOST === "0.0.0.0" &&
  !process.env.GOOGLE_OAUTH_REDIRECT_URI
) {
  console.warn(
    "GOOGLE_OAUTH_REDIRECT_URI is not set; set it to the origin you browse the dashboard from + /api/drive/callback (e.g. http://localhost:8080/api/drive/callback) and register it in Google Cloud.",
  );
}
// The same dir the results route reads from.
const runOutDir = defaultRunOutDir;
// hub.emit is synchronous, as the run manager requires.
const runManager = createRunManager({
  store,
  emit: hub.emit,
  runOutDir,
  driveAuth,
  now: () => new Date().toISOString(),
});

const app = buildApp({
  store,
  runManager,
  hub,
  driveAuth,
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
  // First thing: no queued run may be auto-started while we wind down.
  await step(() => runManager.shutdown());
  await step(() => app.close());
  // Stop every in-flight scrape so each can record its state before the db closes.
  await step(() => stopActiveRuns(runManager, SHUTDOWN_IDLE_TIMEOUT_MS));
  await step(() => closeBrowser());
  await step(() => db.close());
  process.exit(code);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

try {
  await app.listen({ port: PORT, host: HOST });
  console.log(`dashboard server listening on http://${HOST}:${PORT}`);
} catch (err) {
  console.error(err);
  process.exit(1);
}
