import { dashboardClient } from "@/lib/api-client";
import type { ApiClient } from "@/lib/http/api-client";
import { driveConnectSchema, driveStatusSchema } from "@/lib/schemas";
import type { DriveConnect, DriveStatus } from "@/lib/schemas";

export function fetchDriveStatus(
  signal?: AbortSignal,
  client: ApiClient = dashboardClient,
): Promise<DriveStatus> {
  return client.get("/api/drive/status", {
    schema: driveStatusSchema,
    signal,
  });
}

/**
 * Starts the OAuth flow. Must go through the same-origin API client: the
 * server sets the HttpOnly `state` cookie on this response.
 */
export function connectDrive(
  client: ApiClient = dashboardClient,
): Promise<DriveConnect> {
  return client.get("/api/drive/connect", { schema: driveConnectSchema });
}

export function disconnectDrive(
  client: ApiClient = dashboardClient,
): Promise<void> {
  return client.post("/api/drive/disconnect", {});
}
