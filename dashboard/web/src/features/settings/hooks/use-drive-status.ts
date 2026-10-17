import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { dashboardClient } from "@/lib/api-client";
import type { ApiClient } from "@/lib/http/api-client";
import { retryApiQuery } from "@/lib/query-retry";
import {
  connectDrive,
  disconnectDrive,
  fetchDriveStatus,
} from "../api/drive-api";

export const driveStatusKey = ["drive", "status"] as const;

export function useDriveStatus(client: ApiClient = dashboardClient) {
  return useQuery({
    queryKey: driveStatusKey,
    queryFn: ({ signal }) => fetchDriveStatus(signal, client),
    retry: retryApiQuery,
  });
}

export function useDriveMutations(client: ApiClient = dashboardClient) {
  const queryClient = useQueryClient();

  const connect = useMutation({
    mutationFn: async () => {
      const { url } = await connectDrive(client);
      // Full-page navigation to Google's consent screen; the callback
      // redirects back to /settings?drive=<outcome>.
      window.location.href = url;
    },
  });

  const disconnect = useMutation({
    mutationFn: () => disconnectDrive(client),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: driveStatusKey }),
  });

  return { connect, disconnect };
}
