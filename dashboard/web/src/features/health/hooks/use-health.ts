import { useQuery } from "@tanstack/react-query";
import { dashboardClient } from "@/lib/api-client";
import type { ApiClient } from "@/lib/http/api-client";
import { fetchHealth } from "../api/health-api";

const HEALTH_POLL_MS = 15_000;

/**
 * Engine liveness for the sidebar. Failures aren't retried (the indicator
 * should flip promptly) but the poll keeps running so it recovers on its own.
 */
export function useHealth(client: ApiClient = dashboardClient) {
  return useQuery({
    queryKey: ["health"],
    queryFn: ({ signal }) => fetchHealth(signal, client),
    retry: false,
    refetchInterval: HEALTH_POLL_MS,
  });
}
