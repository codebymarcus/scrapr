import { dashboardClient } from "@/lib/api-client";
import type { ApiClient } from "@/lib/http/api-client";
import {
  driveAccountsSchema,
  driveConnectSchema,
  driveStatusSchema,
} from "@/lib/schemas";
import type { DriveAccounts, DriveConnect, DriveStatus } from "@/lib/schemas";

export function fetchDriveStatus(
  signal?: AbortSignal,
  client: ApiClient = dashboardClient,
): Promise<DriveStatus> {
  return client.get("/api/drive/status", {
    schema: driveStatusSchema,
    signal,
  });
}

export function fetchDriveAccounts(
  signal?: AbortSignal,
  client: ApiClient = dashboardClient,
): Promise<DriveAccounts> {
  return client.get("/api/drive/accounts", {
    schema: driveAccountsSchema,
    signal,
  });
}

/**
 * Starts the OAuth flow. With an `accountId` the server re-authorizes that
 * existing account (card-scoped reconnect); without one it adds a new account.
 * Must go through the same-origin API client: the
 * server sets the HttpOnly `state` cookie on this response.
 */
export function connectDrive(
  client: ApiClient = dashboardClient,
  accountId?: string,
): Promise<DriveConnect> {
  return client.get("/api/drive/connect", {
    schema: driveConnectSchema,
    params: accountId === undefined ? undefined : { accountId },
  });
}

export function disconnectDrive(
  client: ApiClient = dashboardClient,
): Promise<void> {
  return client.post("/api/drive/disconnect", {});
}

export function disconnectAccount(
  id: string,
  client: ApiClient = dashboardClient,
): Promise<void> {
  return client.post(
    `/api/drive/accounts/${encodeURIComponent(id)}/disconnect`,
    {},
  );
}

export function renameAccount(
  id: string,
  label: string,
  client: ApiClient = dashboardClient,
): Promise<void> {
  return client.patch(`/api/drive/accounts/${encodeURIComponent(id)}`, {
    body: { label },
  });
}
