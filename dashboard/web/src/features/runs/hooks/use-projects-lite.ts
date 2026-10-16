import { useQuery } from "@tanstack/react-query";
import { dashboardClient } from "@/lib/api-client";
import type { ApiClient } from "@/lib/http/api-client";
import { retryApiQuery } from "@/lib/query-retry";
import { fetchProjects } from "../api/projects-lite-api";

// STOPGAP for Task 8: the shared key matches the projects list so the real
// projects hooks can take over the same cache entry when they land.
export const PROJECTS_LIST_KEY = ["projects", "list"] as const;

export function useProjectsLite(client: ApiClient = dashboardClient) {
  return useQuery({
    queryKey: PROJECTS_LIST_KEY,
    queryFn: ({ signal }) => fetchProjects(signal, client),
    retry: retryApiQuery,
  });
}
