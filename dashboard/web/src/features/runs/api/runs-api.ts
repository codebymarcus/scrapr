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
