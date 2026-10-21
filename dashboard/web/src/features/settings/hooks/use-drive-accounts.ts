import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { dashboardClient } from "@/lib/api-client";
import type { ApiClient } from "@/lib/http/api-client";
import { retryApiQuery } from "@/lib/query-retry";
import {
  connectDrive,
  disconnectAccount,
  fetchDriveAccounts,
  renameAccount,
} from "../api/drive-api";

export const driveAccountsKey = ["drive", "accounts"] as const;

export function useDriveAccounts(client: ApiClient = dashboardClient) {
  return useQuery({
    queryKey: driveAccountsKey,
    queryFn: ({ signal }) => fetchDriveAccounts(signal, client),
    retry: retryApiQuery,
  });
}

/**
 * Starts the OAuth flow. Without an `accountId` it adds a new account; with
 * one it re-authorizes that account.
 */
export function useConnectDrive(client: ApiClient = dashboardClient) {
  return useMutation({
    mutationFn: async (accountId?: string) => {
      const { url } = await connectDrive(client, accountId);
      // Full-page navigation to Google's consent screen; the callback
      // redirects back to /settings?drive=<outcome>.
      window.location.href = url;
    },
  });
}

export function useDisconnectAccount(
  id: string,
  client: ApiClient = dashboardClient,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => disconnectAccount(id, client),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: driveAccountsKey }),
  });
}

export function useRenameAccount(
  id: string,
  client: ApiClient = dashboardClient,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (label: string) => renameAccount(id, label, client),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: driveAccountsKey }),
  });
}
