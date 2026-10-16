import { z } from "zod";
import { dashboardClient } from "@/lib/api-client";
import type { ApiClient } from "@/lib/http/api-client";

const healthSchema = z.object({ ok: z.boolean() });

export type Health = z.infer<typeof healthSchema>;

export function fetchHealth(
  signal?: AbortSignal,
  client: ApiClient = dashboardClient,
): Promise<Health> {
  return client.get("/api/health", { schema: healthSchema, signal });
}
