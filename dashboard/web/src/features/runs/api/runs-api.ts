import { z } from "zod";
import type { ApiClient } from "@/lib/http/api-client";
import { dashboardClient } from "@/lib/api-client";
import { runDetailSchema, runSchema } from "@/lib/schemas";
import type { Run, RunDetail } from "@/lib/schemas";

const runsEnvelopeSchema = z.object({ runs: z.array(runSchema) });

export async function fetchRuns(
  signal?: AbortSignal,
  client: ApiClient = dashboardClient,
): Promise<Run[]> {
  const { runs } = await client.get("/api/runs", {
    schema: runsEnvelopeSchema,
    signal,
  });
  return runs;
}

export function fetchRun(
  id: number,
  signal?: AbortSignal,
  client: ApiClient = dashboardClient,
): Promise<RunDetail> {
  return client.get(`/api/runs/${id}`, { schema: runDetailSchema, signal });
}

export function startRun(
  id: number,
  client: ApiClient = dashboardClient,
): Promise<void> {
  return client.post(`/api/runs/${id}/start`, {});
}

export function stopRun(
  id: number,
  client: ApiClient = dashboardClient,
): Promise<void> {
  return client.post(`/api/runs/${id}/stop`, {});
}

const createRunEnvelopeSchema = z.object({ run: runSchema });
const addedSchema = z.object({ added: z.number() });
// `/api/runs/import`: `{ added }` when a runId was given, else `{ urls }`.
const importResponseSchema = z.union([
  addedSchema,
  z.object({ urls: z.array(z.string()) }),
]);

export type ImportResponse = z.infer<typeof importResponseSchema>;

export async function createRun(
  input: { projectId: number; label?: string },
  client: ApiClient = dashboardClient,
): Promise<Run> {
  const { run } = await client.post("/api/runs", {
    body: input,
    schema: createRunEnvelopeSchema,
  });
  return run;
}

export function enqueueItems(
  runId: number,
  urls: string[],
  client: ApiClient = dashboardClient,
): Promise<{ added: number }> {
  return client.post(`/api/runs/${runId}/items`, {
    body: { urls },
    schema: addedSchema,
  });
}

export function importList(
  input: { path: string; runId?: number },
  client: ApiClient = dashboardClient,
): Promise<ImportResponse> {
  return client.post("/api/runs/import", {
    body: input,
    schema: importResponseSchema,
  });
}
