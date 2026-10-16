import { useQuery } from "@tanstack/react-query";
import { dashboardClient } from "@/lib/api-client";
import type { ApiClient } from "@/lib/http/api-client";
import { retryApiQuery } from "@/lib/query-retry";
import { fetchDriveStatus } from "../api/drive-api";

export const driveStatusKey = ["drive", "status"] as const;

export function useDriveStatus(client: ApiClient = dashboardClient) {
  return useQuery({
    queryKey: driveStatusKey,
    queryFn: ({ signal }) => fetchDriveStatus(signal, client),
    retry: retryApiQuery,
  });
}
