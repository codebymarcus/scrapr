import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uploadItem } from "../src/upload-item.mjs";

function setup({ recipe = { name: "Img", contentType: "image" }, item = {}, authConfig = { clientId: "c", clientSecret: "s", token: {} }, files = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "upload-item-"));
  for (const f of files) writeFileSync(join(dir, f), "x");
  const run = { id: 1, project_id: 7, state: "done", overrides: { driveFolder: "F" } };
  const items = new Map([
    [5, { id: 5, run_id: 1, output_name: "Ch 1", saved: 3, uploaded_at: null, drive_link: null, ...item }],
  ]);
  const uploads = [];
  const store = {
    getRun: (id) => (id === 1 ? run : null),
    getProject: (id) => (id === 7 ? { id: 7, recipe } : null),
    getItem: (id) => items.get(id) ?? null,
    setItemUpload: (id, { uploadedAt, driveLink, outputSize }) => {
      uploads.push({ id, uploadedAt, driveLink, outputSize });
      Object.assign(items.get(id), { uploaded_at: uploadedAt, drive_link: driveLink, output_size: outputSize });
    },
  };
  const driveAuth = {
    loadAuthConfig: () => authConfig,
    // Single-connected back-compat: the run carries no driveAccountId here.
    listAccounts: () => (authConfig ? [{ id: "acc", connected: true }] : []),
  };
  const calls = { configs: [], paths: [] };
  const driveUploaderFactory = async (config) => {
    calls.configs.push(config);
    return {
      uploadFile: async (p) => {
        calls.paths.push(p);
        return { id: "d1", webViewLink: "https://drive/x" };
      },
    };
  };
  const deps = { store, driveAuth, runOutDir: () => dir, driveUploaderFactory };
  return { deps, items, uploads, calls, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("uploads the cbz and records uploaded_at + drive_link", async () => {
  const s = setup({ files: ["Ch 1.cbz", "Ch 1.pdf"] });
  const res = await uploadItem(s.deps, 1, 5);
  assert.deepEqual(res, { driveLink: "https://drive/x", outputSize: 1 });
  assert.equal(s.uploads[0].outputSize, 1);
  assert.equal(s.items.get(5).output_size, 1);
  assert.deepEqual(s.calls.paths, [join(s.dir, "Ch 1.cbz")]);
  assert.equal(s.uploads.length, 1);
  assert.ok(s.uploads[0].uploadedAt);
  assert.equal(s.items.get(5).drive_link, "https://drive/x");
  assert.equal(s.calls.configs[0].driveFolder, "F");
  assert.equal(s.calls.configs[0].out, s.dir);
  s.cleanup();
});

test("falls back to pdf when no cbz", async () => {
  const s = setup({ files: ["Ch 1.pdf"] });
  await uploadItem(s.deps, 1, 5);
  assert.deepEqual(s.calls.paths, [join(s.dir, "Ch 1.pdf")]);
  s.cleanup();
});

test("missing output file -> no_output, upload state unchanged", async () => {
  const s = setup();
  await assert.rejects(uploadItem(s.deps, 1, 5), { code: "no_output" });
  assert.equal(s.uploads.length, 0);
  assert.equal(s.calls.paths.length, 0);
  assert.equal(s.items.get(5).uploaded_at, null);
  s.cleanup();
});

test("item without an output_name -> no_output", async () => {
  const s = setup({ item: { output_name: null } });
  await assert.rejects(uploadItem(s.deps, 1, 5), { code: "no_output" });
  s.cleanup();
});

test("Drive not connected -> unavailable, nothing uploaded", async () => {
  const s = setup({ authConfig: null, files: ["Ch 1.cbz"] });
  await assert.rejects(uploadItem(s.deps, 1, 5), { code: "unavailable" });
  assert.equal(s.calls.paths.length, 0);
  assert.equal(s.uploads.length, 0);
  s.cleanup();
});

test("resolves by the run's driveAccountId; a gone account -> unavailable, nothing uploaded", async () => {
  const s = setup({ files: ["Ch 1.cbz"] });
  s.deps.store.getRun = (id) => (id === 1 ? { id: 1, project_id: 7, state: "done", overrides: { driveFolder: "F", driveAccountId: "gone" } } : null);
  s.deps.driveAuth = {
    loadAuthConfig: (id) => (id === "ok" ? { clientId: "c", clientSecret: "s", token: {} } : null),
    listAccounts: () => [{ id: "ok", connected: true }, { id: "other", connected: true }],
  };
  await assert.rejects(uploadItem(s.deps, 1, 5), { code: "unavailable" });
  assert.equal(s.calls.paths.length, 0);
  assert.equal(s.uploads.length, 0);
  s.cleanup();
});

test("resolves by the run's driveAccountId; an available account uploads", async () => {
  const s = setup({ files: ["Ch 1.cbz"] });
  s.deps.store.getRun = (id) => (id === 1 ? { id: 1, project_id: 7, state: "done", overrides: { driveFolder: "F", driveAccountId: "ok" } } : null);
  s.deps.driveAuth = {
    loadAuthConfig: (id) => (id === "ok" ? { clientId: "c", clientSecret: "s", token: {} } : null),
    listAccounts: () => [{ id: "ok", connected: true }, { id: "other", connected: true }],
  };
  const res = await uploadItem(s.deps, 1, 5);
  assert.equal(res.driveLink, "https://drive/x");
  assert.equal(s.calls.paths.length, 1);
  s.cleanup();
});

test("text recipe -> unavailable", async () => {
  const s = setup({ recipe: { name: "T", contentType: "text" }, files: ["Ch 1.cbz"] });
  await assert.rejects(uploadItem(s.deps, 1, 5), { code: "unavailable" });
  s.cleanup();
});

test("unknown run, unknown item, or run mismatch -> not_found", async () => {
  const s = setup({ files: ["Ch 1.cbz"] });
  await assert.rejects(uploadItem(s.deps, 99, 5), { code: "not_found" });
  await assert.rejects(uploadItem(s.deps, 1, 99), { code: "not_found" });
  s.items.get(5).run_id = 2;
  await assert.rejects(uploadItem(s.deps, 1, 5), { code: "not_found" });
  s.cleanup();
});

test("already-uploaded row: re-upload is idempotent and still records a link", async () => {
  const s = setup({ files: ["Ch 1.cbz"], item: { uploaded_at: "2026-01-01T00:00:00.000Z", drive_link: "https://old" } });
  const res = await uploadItem(s.deps, 1, 5);
  assert.equal(res.driveLink, "https://drive/x");
  assert.equal(s.items.get(5).drive_link, "https://drive/x");
  s.cleanup();
});

test("Drive 'already there' with no webViewLink -> records a null link, no error", async () => {
  const s = setup({ files: ["Ch 1.cbz"] });
  s.deps.driveUploaderFactory = async () => ({ uploadFile: async () => ({ id: "d1" }) });
  const res = await uploadItem(s.deps, 1, 5);
  assert.deepEqual(res, { driveLink: null, outputSize: 1 });
  assert.equal(s.uploads.length, 1);
  assert.ok(s.items.get(5).uploaded_at);
  s.cleanup();
});

test("uploader reports the file missing (null) -> no_output, state unchanged", async () => {
  const s = setup({ files: ["Ch 1.cbz"] });
  s.deps.driveUploaderFactory = async () => ({ uploadFile: async () => null });
  await assert.rejects(uploadItem(s.deps, 1, 5), { code: "no_output" });
  assert.equal(s.uploads.length, 0);
  s.cleanup();
});
