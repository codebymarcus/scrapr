import { existsSync } from "node:fs";
import { join } from "node:path";
import { DriveUploader } from "../../../src/drive.mjs";
import { buildRunConfig } from "./build-run-config.mjs";

// Typed error: `code` is one of "not_found" | "unavailable" | "no_output" so
// routes can map it to an HTTP status.
export class UploadItemError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "UploadItemError";
    this.code = code;
  }
}

// DriveUploader only calls these; on-demand uploads are silent (no run log to feed).
const silentLogger = {
  info() {},
  muted() {},
  success() {},
  warn() {},
  progressBar() {},
};

// Packaged output for an item: `<outDir>/<output_name>.cbz`, else `.pdf`.
function findOutputFile(outDir, outputName) {
  if (!outputName) return null;
  for (const ext of [".cbz", ".pdf"]) {
    const path = join(outDir, `${outputName}${ext}`);
    if (existsSync(path)) return path;
  }
  return null;
}

// Upload one already-scraped item to Drive on demand. Idempotent: the uploader
// returns the existing Drive file when it is already there, and we simply
// re-record its link. Resolves { driveLink }.
export async function uploadItem(deps, runId, itemId) {
  const { store, driveAuth, runOutDir, driveUploaderFactory = DriveUploader.create, logger = silentLogger } = deps;

  const run = store.getRun(runId);
  if (!run) throw new UploadItemError("not_found", "Run not found");
  const item = store.getItem(itemId);
  if (!item || item.run_id !== run.id) throw new UploadItemError("not_found", "Item not found");

  const project = run.project_id == null ? null : store.getProject(run.project_id);
  if (!project) throw new UploadItemError("unavailable", "Run has no project");
  const recipe = project.recipe;
  if (recipe?.contentType === "text") {
    throw new UploadItemError("unavailable", "Text runs have no files to upload");
  }
  const authConfig = driveAuth?.loadAuthConfig?.() ?? null;
  if (!authConfig) throw new UploadItemError("unavailable", "Google Drive is not connected");

  const outDir = runOutDir(run);
  const filePath = findOutputFile(outDir, item.output_name);
  if (!filePath) throw new UploadItemError("no_output", "Output file for this item was not found");

  const config = buildRunConfig(recipe, { runOutDir: outDir, overrides: run.overrides, driveAuth: authConfig });
  const uploader = await driveUploaderFactory(config, logger);
  const res = await uploader.uploadFile(filePath);
  if (!res) throw new UploadItemError("no_output", "Output file for this item was not found");

  const driveLink = res.webViewLink ?? null;
  store.setItemUpload(itemId, { uploadedAt: new Date().toISOString(), driveLink });
  return { driveLink };
}
