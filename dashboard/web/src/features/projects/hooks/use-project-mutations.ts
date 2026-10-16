import { useMutation, useQueryClient } from "@tanstack/react-query";
import { dashboardClient } from "@/lib/api-client";
import { ApiError } from "@/lib/http/api-error";
import type { ApiClient } from "@/lib/http/api-client";
import {
  createProject,
  deleteProject,
  updateProject,
} from "../api/projects-api";
import type {
  DeleteProjectResult,
  ProjectInput,
  ProjectUpdate,
} from "../types";
import { projectKeys } from "./projects-keys";

export function useCreateProject(client: ApiClient = dashboardClient) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ProjectInput) => createProject(input, client),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: projectKeys.all }),
  });
}

export function useUpdateProject(client: ApiClient = dashboardClient) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, changes }: { id: number; changes: ProjectUpdate }) =>
      updateProject(id, changes, client),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: projectKeys.all }),
  });
}

export function useDeleteProject(client: ApiClient = dashboardClient) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: number): Promise<DeleteProjectResult> => {
      try {
        await deleteProject(id, client);
        return { ok: true };
      } catch (error) {
        if (
          error instanceof ApiError &&
          error.kind === "http" &&
          error.status === 409
        ) {
          // `message` carries the server's "has runs" text.
          return { ok: false, error: error.message };
        }
        throw error;
      }
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: projectKeys.all }),
  });
}
