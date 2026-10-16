import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { resolveRecordBase } from "../../../../src/naming.mjs";
import { DATA_DIR } from "../config.mjs";
import { importSheet } from "../import-sheet.mjs";
import { createRunSchema, enqueueSchema, parseOr400 } from "../schemas.mjs";
import { z } from "zod";

const importSchema = z.object({
  path: z.string().min(1),
  runId: z.number().int().positive().optional(),
});

const SHEET_EXT = /\.(csv|tsv|txt|xlsx|xls)$/i;

// Runs accept new items only while not executing (spec 8.1: no live-append).
const ENQUEUEABLE = new Set(["queued", "stopped"]);

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
  const base = resolveRecordBase({ out: outDir, listFile: true });
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

export async function runRoutes(app, { store, runOutDir = defaultRunOutDir }) {
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
    const { projectId, label } = parsed.data;
    if (!store.getProject(projectId)) return reply.code(404).send({ error: "Project not found" });
    return reply.code(201).send({ run: store.createRun({ projectId, label: label ?? null }) });
  });

  app.get("/api/runs", async () => ({ runs: store.listRuns() }));

  // v1 import contract: JSON body { path, runId? } where `path` is a file the
  // server can read (csv/tsv/txt/xlsx/xls). Multipart upload can come later.
  // Without runId the parsed URLs are returned ({ urls }); with runId they are
  // enqueued into that run ({ added }) under the same rules as /items.
  app.post("/api/runs/import", async (request, reply) => {
    const parsed = parseOr400(importSchema, request.body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    const { path, runId } = parsed.data;
    if (!SHEET_EXT.test(path)) {
      return reply.code(400).send({ error: "Unsupported file type (use csv, tsv, txt, xlsx or xls)" });
    }
    let info;
    try {
      info = await stat(path);
    } catch {
      return reply.code(400).send({ error: "File not found or unreadable" });
    }
    if (!info.isFile()) return reply.code(400).send({ error: "Path is not a file" });

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

    let urls;
    try {
      urls = await importSheet(path);
    } catch (err) {
      return reply.code(400).send({ error: `Could not parse sheet: ${err.message}` });
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
}
