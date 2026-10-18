import { readFile, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { resolveRecordBase } from "../../../../src/naming.mjs";
import { DATA_DIR } from "../config.mjs";
import { importSheet } from "../import-sheet.mjs";
import { createRunSchema, enqueueSchema, parseOr400 } from "../schemas.mjs";

const SHEET_EXT = /\.(csv|tsv|txt|xlsx|xls)$/i;

// Runs accept new items only while not executing (spec 8.1: no live-append).
const ENQUEUEABLE = new Set(["queued", "stopped"]);
// A run can be started only from these states (same set as enqueueing).
const STARTABLE = ENQUEUEABLE;

// Parse a route :id param as a positive integer; returns null when invalid.
function parseId(raw) {
  if (!/^[1-9]\d*$/.test(String(raw))) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : null;
}

// Default per-run output directory. The run manager must write a run's
// outputs here (or inject the same `runOutDir` into both) for results to show.
export function defaultRunOutDir(run) {
  return join(DATA_DIR, "runs", String(run.id));
}

async function readTextRecords(outDir) {
  // Must match the engine's write path: the run config leaves listFile/textName
  // null, so RecordWriter writes `${resolveRecordBase(config)}.json` = `${outDir}.json`.
  const base = resolveRecordBase({ out: outDir });
  try {
    const parsed = JSON.parse(await readFile(`${base}.json`, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function listImageOutputs(outDir) {
  let entries;
  try {
    entries = await readdir(outDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const outputs = [];
  for (const entry of entries) {
    try {
      const info = await stat(join(outDir, entry.name));
      outputs.push({ name: entry.name, size: info.isDirectory() ? null : info.size });
    } catch {
      // vanished between readdir and stat; skip
    }
  }
  return outputs.sort((a, b) => a.name.localeCompare(b.name));
}

export async function runRoutes(app, { store, runManager, runOutDir = defaultRunOutDir }) {
  function withId(handler) {
    return async (request, reply) => {
      const id = parseId(request.params.id);
      if (id === null) {
        return reply.code(400).send({ error: "Run id must be a positive integer" });
      }
      return handler(id, request, reply);
    };
  }

  function enqueue(run, urls, reply) {
    if (!ENQUEUEABLE.has(run.state)) {
      return reply.code(409).send({
        error: `Cannot add items to a ${run.state} run (only queued or stopped runs accept items)`,
      });
    }
    store.addItems(run.id, urls);
    return { added: urls.length };
  }

  app.post("/api/runs", async (request, reply) => {
    const parsed = parseOr400(createRunSchema, request.body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    const { projectId, label, overrides } = parsed.data;
    if (!store.getProject(projectId)) return reply.code(404).send({ error: "Project not found" });
    return reply.code(201).send({ run: store.createRun({ projectId, label: label ?? null, overrides }) });
  });

  app.get("/api/runs", async () => ({ runs: store.listRuns() }));

  // Import contract: multipart/form-data upload with a `file` part (the sheet:
  // csv/tsv/txt/xlsx/xls) and an optional `runId` field. Without runId the
  // parsed URLs are returned ({ urls }); with runId they are enqueued into that
  // run ({ added }) under the same rules as /items. The upload is written to a
  // temp file (keeping its extension so the engine parses it correctly), parsed,
  // and deleted — the server never reads an arbitrary caller-supplied path.
  app.post("/api/runs/import", async (request, reply) => {
    // Consume the whole multipart stream first so field order doesn't matter: a
    // `runId` field after the file part is only parsed once the file is read.
    let buffer = null;
    let filename = "";
    let truncated = false;
    let rawRunId;
    try {
      for await (const part of request.parts()) {
        if (part.type === "file") {
          if (buffer === null) {
            buffer = await part.toBuffer();
            filename = part.filename || "";
            truncated = part.file.truncated;
          } else {
            await part.toBuffer().catch(() => {}); // drain any extra file
          }
        } else if (part.fieldname === "runId") {
          rawRunId = part.value;
        }
      }
    } catch (err) {
      return reply.code(400).send({ error: `Invalid upload: ${err.message}` });
    }

    if (buffer === null) {
      return reply.code(400).send({ error: "Upload a spreadsheet file (field name 'file')" });
    }
    const extMatch = SHEET_EXT.exec(filename);
    if (!extMatch) {
      return reply.code(400).send({ error: "Unsupported file type (use csv, tsv, txt, xlsx or xls)" });
    }
    const ext = extMatch[0].toLowerCase();
    if (truncated) {
      return reply.code(413).send({ error: "Uploaded file is too large" });
    }

    let runId;
    if (rawRunId !== undefined && rawRunId !== "") {
      runId = Number(rawRunId);
      if (!Number.isInteger(runId) || runId <= 0) {
        return reply.code(400).send({ error: "runId must be a positive integer" });
      }
    }

    let run = null;
    if (runId !== undefined) {
      run = store.getRun(runId);
      if (!run) return reply.code(404).send({ error: "Run not found" });
      if (!ENQUEUEABLE.has(run.state)) {
        return reply.code(409).send({
          error: `Cannot add items to a ${run.state} run (only queued or stopped runs accept items)`,
        });
      }
    }

    const tempPath = join(tmpdir(), `scrapr-import-${randomUUID()}${ext}`);
    let urls;
    try {
      await writeFile(tempPath, buffer);
      urls = await importSheet(tempPath);
    } catch (err) {
      return reply.code(400).send({ error: `Could not parse sheet: ${err.message}` });
    } finally {
      await unlink(tempPath).catch(() => {});
    }
    if (!run) return { urls };
    return enqueue(run, urls, reply);
  });

  app.get(
    "/api/runs/:id",
    withId(async (id, request, reply) => {
      const run = store.getRun(id);
      if (!run) return reply.code(404).send({ error: "Run not found" });
      return { run, items: store.listItems(id) };
    }),
  );

  app.post(
    "/api/runs/:id/items",
    withId(async (id, request, reply) => {
      const run = store.getRun(id);
      if (!run) return reply.code(404).send({ error: "Run not found" });
      const parsed = parseOr400(enqueueSchema, request.body);
      if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
      return enqueue(run, parsed.data.urls, reply);
    }),
  );

  // Results are read defensively from the run's output dir: missing or
  // corrupt files yield an empty result, never a 500.
  app.get(
    "/api/runs/:id/results",
    withId(async (id, request, reply) => {
      const run = store.getRun(id);
      if (!run) return reply.code(404).send({ error: "Run not found" });
      const project = run.project_id == null ? null : store.getProject(run.project_id);
      const contentType = project?.recipe?.contentType === "text" ? "text" : "image";
      const outDir = runOutDir(run);
      if (contentType === "text") {
        return { contentType, records: await readTextRecords(outDir) };
      }
      return { contentType, outputs: await listImageOutputs(outDir) };
    }),
  );

  // Delete a run: its items and its output dir go too. A running run must be
  // stopped first (409). Already-uploaded Drive files are never touched.
  app.delete(
    "/api/runs/:id",
    withId(async (id, request, reply) => {
      const run = store.getRun(id);
      if (!run) return reply.code(404).send({ error: "Run not found" });
      if (run.state === "running") {
        return reply.code(409).send({ error: "Cannot delete a running run (stop it first)" });
      }
      // Remove outputs before the DB row: force ignores a missing dir, so a
      // run that never produced output deletes cleanly.
      await rm(runOutDir(run), { recursive: true, force: true });
      store.deleteRun(id);
      return { deleted: true };
    }),
  );

  // Start/stop are only exposed when a run manager is wired in.
  if (runManager) {
    // Responds as soon as the run has been handed to the manager; the run itself
    // executes in the background (progress arrives over the WebSocket). If another
    // run is active the run stays queued and starts when the slot frees up.
    app.post(
      "/api/runs/:id/start",
      withId(async (id, request, reply) => {
        const run = store.getRun(id);
        if (!run) return reply.code(404).send({ error: "Run not found" });
        if (!STARTABLE.has(run.state)) {
          return reply.code(409).send({
            error: `Cannot start a ${run.state} run (only queued or stopped runs can be started)`,
          });
        }
        const outcome = runManager.start(id);
        // Never await the run itself; just make sure a rejection cannot go unhandled.
        Promise.resolve(outcome).catch(() => {});
        return { run: store.getRun(id) };
      }),
    );

    app.post(
      "/api/runs/:id/stop",
      withId(async (id, request, reply) => {
        const run = store.getRun(id);
        if (!run) return reply.code(404).send({ error: "Run not found" });
        if (!runManager.stop(id)) {
          return reply.code(409).send({ error: "Run is not running, nothing to stop" });
        }
        return { stopped: true };
      }),
    );
  }
}
