import { useQuery } from "@tanstack/react-query";
import { dashboardClient } from "@/lib/api-client";
import type { ApiClient } from "@/lib/http/api-client";
import { retryApiQuery } from "@/lib/query-retry";
import { fetchRuns } from "../api/runs-api";
import { runKeys } from "./runs-keys";

export function useRuns(client: ApiClient = dashboardClient) {
  return useQuery({
    queryKey: runKeys.lists(),
    queryFn: ({ signal }) => fetchRuns(signal, client),
    retry: retryApiQuery,
  });
}
