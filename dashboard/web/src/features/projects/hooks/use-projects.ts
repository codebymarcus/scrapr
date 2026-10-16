import { useQuery } from "@tanstack/react-query";
import { dashboardClient } from "@/lib/api-client";
import type { ApiClient } from "@/lib/http/api-client";
import { retryApiQuery } from "@/lib/query-retry";
import { fetchProjects } from "../api/projects-api";
import { projectKeys } from "./projects-keys";

export function useProjects(client: ApiClient = dashboardClient) {
  return useQuery({
    queryKey: projectKeys.lists(),
    queryFn: ({ signal }) => fetchProjects(signal, client),
    retry: retryApiQuery,
  });
}
