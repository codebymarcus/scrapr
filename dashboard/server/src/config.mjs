import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULTS } from "../../../src/config.mjs";

const here = dirname(fileURLToPath(import.meta.url));

// dashboard/server/src -> repo root is three levels up.
export const REPO_ROOT = resolve(here, "../../..");
export const SERVER_ROOT = resolve(here, "..");

export const PORT = Number(process.env.PORT) || 5174;
// Bind host: 127.0.0.1 by default (safe for local use); set HOST=0.0.0.0 in a
// container so the reverse proxy / other services can reach it.
export const HOST = process.env.HOST || "127.0.0.1";
export const DATA_DIR = resolve(SERVER_ROOT, "data");

// The engine resolves these relative to its cwd (the repo root, where
// authorize.mjs writes them), so resolve against REPO_ROOT, not process.cwd().
export const DRIVE_CREDENTIALS_PATH = resolve(REPO_ROOT, DEFAULTS.driveCredentials);
export const DRIVE_TOKEN_PATH = resolve(REPO_ROOT, DEFAULTS.driveToken);
