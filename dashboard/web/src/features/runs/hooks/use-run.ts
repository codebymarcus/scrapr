import { useQuery } from "@tanstack/react-query";
import { dashboardClient } from "@/lib/api-client";
import type { ApiClient } from "@/lib/http/api-client";
import { retryApiQuery } from "@/lib/query-retry";
import { fetchRun } from "../api/runs-api";
import type { CachedRunDetail } from "../types";
import { runKeys } from "./runs-keys";

type UseRunOptions = {
  /** Poll interval in ms, or false for none (e.g. while a live socket is up). */
  refetchInterval?: number | false;
};

export function useRun(
  id: number | null,
  client: ApiClient = dashboardClient,
  { refetchInterval = false }: UseRunOptions = {},
) {
  // The cache entry may carry live socket-only data (progress, logs) that the
  // fetch itself never returns, hence the wider type.
  return useQuery<CachedRunDetail>({
    queryKey: runKeys.detail(id ?? -1),
    queryFn: ({ signal }) => fetchRun(id as number, signal, client),
    enabled: id !== null,
    retry: retryApiQuery,
    refetchInterval,
  });
}
