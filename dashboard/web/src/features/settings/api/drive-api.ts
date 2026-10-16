import { dashboardClient } from "@/lib/api-client";
import type { ApiClient } from "@/lib/http/api-client";
import { driveStatusSchema } from "@/lib/schemas";
import type { DriveStatus } from "@/lib/schemas";

export function fetchDriveStatus(
  signal?: AbortSignal,
  client: ApiClient = dashboardClient,
): Promise<DriveStatus> {
  return client.get("/api/drive/status", {
    schema: driveStatusSchema,
    signal,
  });
}
