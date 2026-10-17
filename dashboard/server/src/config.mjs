import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULTS } from "../../../src/config.mjs";
import { keyFromEnv } from "./secrets/crypto.mjs";

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

// In-app Google Drive OAuth. All optional: without them the server still boots
// and /api/drive/status reports `configured: false`.
export const GOOGLE_OAUTH_CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID || "";
export const GOOGLE_OAUTH_CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET || "";
export const GOOGLE_OAUTH_REDIRECT_URI =
  process.env.GOOGLE_OAUTH_REDIRECT_URI || `http://localhost:${PORT}/api/drive/callback`;
// Key that encrypts stored secrets (base64 of 32 bytes), or null when unset/invalid.
export const APP_SECRET_KEY = keyFromEnv(process.env);
