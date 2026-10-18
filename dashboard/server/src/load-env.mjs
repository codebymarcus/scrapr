// Loads dashboard/server/.env into process.env before any module reads config.
// Import this FIRST in server.mjs (config.mjs reads process.env at import time).
//
// Two deployment styles, both supported:
//   - Local (`npm start`): `dotenv` is installed, so a dashboard/server/.env is
//     loaded here. Real shell env always wins — dotenv never overrides a set var.
//   - Docker: the image may not include `dotenv`, and env vars come from compose
//     (`env_file:` / `environment:`). The dynamic import below fails softly in
//     that case, so the server boots and uses the env compose already injected.
// A missing .env is a silent no-op in both styles.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// dashboard/server/src -> dashboard/server
const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

try {
  const { config } = await import("dotenv");
  // quiet: suppress dotenv's startup banner so server output stays clean.
  config({ path: resolve(serverRoot, ".env"), quiet: true });
} catch {
  // `dotenv` not installed (e.g. a container image built without it) — rely on
  // the process environment compose/the shell already provides.
}
