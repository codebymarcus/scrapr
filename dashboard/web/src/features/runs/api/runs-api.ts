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

export function deleteRun(
  id: number,
  client: ApiClient = dashboardClient,
): Promise<void> {
  return client.del(`/api/runs/${id}`);
}

const uploadedSchema = z.object({
  uploaded: z.boolean(),
  driveLink: z.string().nullish(),
});
const uploadPendingSchema = z.object({
  uploaded: z.number(),
  skipped: z.number(),
  failed: z.number(),
});

export type UploadItemResult = z.infer<typeof uploadedSchema>;
export type UploadPendingResult = z.infer<typeof uploadPendingSchema>;

export function deleteItem(
  runId: number,
  itemId: number,
  client: ApiClient = dashboardClient,
): Promise<void> {
  return client.del(`/api/runs/${runId}/items/${itemId}`);
}

export function uploadItem(
  runId: number,
  itemId: number,
  client: ApiClient = dashboardClient,
): Promise<UploadItemResult> {
  return client.post(`/api/runs/${runId}/items/${itemId}/upload`, {
    schema: uploadedSchema,
  });
}

export function uploadPending(
  runId: number,
  client: ApiClient = dashboardClient,
): Promise<UploadPendingResult> {
  return client.post(`/api/runs/${runId}/upload-pending`, {
    schema: uploadPendingSchema,
  });
}

export async function retryRun(
  runId: number,
  client: ApiClient = dashboardClient,
): Promise<Run> {
  const { run } = await client.post(`/api/runs/${runId}/retry`, {
    schema: createRunEnvelopeSchema,
  });
  return run;
}

export async function retryItem(
  runId: number,
  itemId: number,
  client: ApiClient = dashboardClient,
): Promise<Run> {
  const { run } = await client.post(`/api/runs/${runId}/items/${itemId}/retry`, {
    schema: createRunEnvelopeSchema,
  });
  return run;
}

const createRunEnvelopeSchema = z.object({ run: runSchema });
const addedSchema = z.object({ added: z.number() });
// `/api/runs/import`: `{ added }` when a runId was given, else `{ urls }`.
const importResponseSchema = z.union([
  addedSchema,
  z.object({ urls: z.array(z.string()) }),
]);

export type ImportResponse = z.infer<typeof importResponseSchema>;

/** Output packaging for a run; maps to the engine's cbz/pdf/keepLoose flags. */
export type RunFormat = "cbz" | "pdf" | "both" | "loose";

/** Per-run output/Drive settings; only keys that are present override the recipe. */
export type RunOverrides = {
  drive?: boolean;
  driveFolder?: string;
  driveSubfolder?: string;
  driveAccountId?: string;
  format?: RunFormat;
  /** Per-run rows-in-flight override; absent means the server default. */
  concurrency?: number;
};

export type CreateRunInput = {
  projectId: number;
  label?: string;
  overrides?: RunOverrides;
};

export async function createRun(
  input: CreateRunInput,
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
  input: { file: File; runId?: number },
  client: ApiClient = dashboardClient,
): Promise<ImportResponse> {
  const form = new FormData();
  // Append runId before the file so it is parsed even if the server read fields
  // in stream order; the server is also order-independent.
  if (input.runId !== undefined) {
    form.append("runId", String(input.runId));
  }
  form.append("file", input.file);
  return client.postForm("/api/runs/import", {
    form,
    schema: importResponseSchema,
  });
}
