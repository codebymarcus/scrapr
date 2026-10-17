// DriveUploader: pushes a finished file (.cbz/.pdf) to Google Drive via the
// Drive API v3. Auth comes from an OAuth "Desktop app" client (credentials.json)
// plus a saved token (token.json) produced by `authorize.mjs`.
//
// Idempotent: before uploading it checks the target folder for a file of the
// same name (created by this app) and skips if present, so re-running a batch
// doesn't create duplicates.
import { google } from "googleapis";
import { createReadStream, existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { sleep, withJitter } from "./time.mjs";

const RETRYABLE_NET = new Set(["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN", "EPIPE"]);
const RATE_LIMIT_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded"]);

// Is a Drive/network error worth retrying? Transient server (5xx), rate-limit
// (429, or 403 with a rate-limit reason), and dropped-connection errors are;
// client errors (401/403-perms/404) are not.
export function isRetryable(err) {
  if (!err) return false;
  const status = typeof err.code === "number" ? err.code : err.response?.status ?? err.status;
  if (status === 429) return true;
  if (typeof status === "number" && status >= 500 && status < 600) return true;
  if (status === 403) {
    const reason = err.errors?.[0]?.reason || err.response?.data?.error?.errors?.[0]?.reason;
    return RATE_LIMIT_REASONS.has(reason);
  }
  return typeof err.code === "string" && RETRYABLE_NET.has(err.code);
}

const MIME_BY_EXT = {
  ".cbz": "application/vnd.comicbook+zip",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".png": "image/png", ".webp": "image/webp"
};

export class DriveUploader {
  constructor(drive, folderId, logger, retry = {}) {
    this.drive = drive;
    this.folderId = folderId || null; // null → My Drive root
    this.logger = logger;
    this.maxRetries = Number.isFinite(retry.maxRetries) ? retry.maxRetries : 4;
    this.rateLimitBase = Number.isFinite(retry.rateLimitBase) ? retry.rateLimitBase : 2000;
  }

  // Run an async Drive operation, retrying transient failures with exponential
  // backoff. Non-retryable errors are rethrown immediately.
  async _withRetry(fn, label) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (e) {
        if (attempt >= this.maxRetries || !isRetryable(e)) throw e;
        const wait = withJitter(this.rateLimitBase * 2 ** attempt, 0.3);
        this.logger.warn(
          `Drive ${label} failed (${e?.code || e?.message || e}); retry ${attempt + 1}/${this.maxRetries} in ${Math.round(wait / 1000)}s`
        );
        await sleep(wait);
      }
    }
  }

  // Build from config; throws a clear, actionable error if not set up yet.
  static async create(config, logger) {
    let auth;
    if (config.driveAuth?.clientId && config.driveAuth?.token) {
      // In-memory credentials (injected by the dashboard); no files are read.
      const { clientId, clientSecret, token } = config.driveAuth;
      auth = new google.auth.OAuth2(clientId, clientSecret);
      auth.setCredentials(token);
    } else {
      const credPath = path.resolve(config.driveCredentials);
      const tokenPath = path.resolve(config.driveToken);
      if (!existsSync(credPath)) {
        throw new Error(`Drive credentials not found at ${credPath}. Download the OAuth "Desktop app" JSON from Google Cloud and save it there.`);
      }
      if (!existsSync(tokenPath)) {
        throw new Error(`Drive token not found at ${tokenPath}. Run "node authorize.mjs" once to authorize.`);
      }
      const raw = JSON.parse(await readFile(credPath, "utf8"));
      const c = raw.installed || raw.web;
      if (!c) throw new Error(`${credPath} is not an OAuth client file (expected an "installed" or "web" key).`);

      auth = new google.auth.OAuth2(c.client_id, c.client_secret, c.redirect_uris?.[0] || "http://localhost");
      auth.setCredentials(JSON.parse(await readFile(tokenPath, "utf8")));
    }
    const drive = google.drive({ version: "v3", auth });
    const uploader = new DriveUploader(drive, config.driveFolder, logger, {
      maxRetries: config.maxRetries,
      rateLimitBase: config.rateLimitBase
    });

    // Create (or reuse) a subfolder inside the target folder, on the fly.
    if (config.driveSubfolder) {
      const id = await uploader.ensureFolder(config.driveSubfolder, config.driveFolder);
      uploader.folderId = id;
      logger.info(`Drive: target subfolder "${config.driveSubfolder}" → ${id}`);
    }
    return uploader;
  }

  // Get-or-create a folder by name under parentId; returns its id (idempotent).
  async ensureFolder(name, parentId) {
    const q = [
      "mimeType = 'application/vnd.google-apps.folder'",
      `name = '${name.replace(/'/g, "\\'")}'`,
      "trashed = false"
    ];
    if (parentId) q.push(`'${parentId}' in parents`);
    const found = await this.drive.files.list({
      q: q.join(" and "),
      fields: "files(id,name)",
      pageSize: 1,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true
    });
    if (found.data.files?.[0]) return found.data.files[0].id;

    const requestBody = { name, mimeType: "application/vnd.google-apps.folder" };
    if (parentId) requestBody.parents = [parentId];
    const created = await this.drive.files.create({ requestBody, fields: "id", supportsAllDrives: true });
    return created.data.id;
  }

  async _findExisting(name) {
    const q = [`name = '${name.replace(/'/g, "\\'")}'`, "trashed = false"];
    if (this.folderId) q.push(`'${this.folderId}' in parents`);
    try {
      const res = await this.drive.files.list({
        q: q.join(" and "),
        fields: "files(id,name)",
        pageSize: 1,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true
      });
      return res.data.files?.[0] || null;
    } catch {
      return null; // if the lookup fails, fall through to a normal upload
    }
  }

  // Upload one local file. Returns the Drive file metadata (or null if missing).
  async uploadFile(filePath) {
    if (!existsSync(filePath)) return null;
    const name = path.basename(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const mimeType = MIME_BY_EXT[ext] || "application/octet-stream";

    const existing = await this._findExisting(name);
    if (existing) {
      this.logger.muted(`Drive: "${name}" already there (${existing.id}) — skipping`);
      return existing;
    }

    const requestBody = { name };
    if (this.folderId) requestBody.parents = [this.folderId];
    const total = statSync(filePath).size;
    // A fresh read stream per attempt — a stream can't be replayed once consumed.
    const res = await this._withRetry(
      () =>
        this.drive.files.create(
          {
            requestBody,
            media: { mimeType, body: createReadStream(filePath) }, // stream ⇒ resumable
            fields: "id,name,webViewLink",
            supportsAllDrives: true
          },
          {
            // The client reports bytes uploaded; combine with file size for a %.
            onUploadProgress: (evt) => {
              const read = Math.min(evt?.bytesRead || 0, total);
              this.logger.progressBar(read, total, `uploading ${name}`, { human: true });
            }
          }
        ),
      `upload "${name}"`
    );
    this.logger.success(`Drive: uploaded "${res.data.name}" (${res.data.id})`);
    return res.data;
  }
}
