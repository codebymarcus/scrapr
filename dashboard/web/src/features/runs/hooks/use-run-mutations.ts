import { useMutation, useQueryClient } from "@tanstack/react-query";
import { dashboardClient } from "@/lib/api-client";
import { ApiError } from "@/lib/http/api-error";
import type { ApiClient } from "@/lib/http/api-client";
import { createRun, enqueueItems, importList } from "../api/runs-api";
import { runKeys } from "./runs-keys";

/**
 * A conflict (409: the run is executing) is an expected outcome, so it is
 * data to show inline, not a throw.
 */
export type ConflictFailure = { ok: false; error: string };
export type EnqueueResult = { ok: true; added: number } | ConflictFailure;
export type ImportResult =
  | { ok: true; added: number }
  | { ok: true; urls: string[] }
  | ConflictFailure;

async function settleConflict<T extends object>(
  action: () => Promise<T>,
): Promise<({ ok: true } & T) | ConflictFailure> {
  try {
    return { ok: true, ...(await action()) };
  } catch (error) {
    if (
      error instanceof ApiError &&
      error.kind === "http" &&
      error.status === 409
    ) {
      // `message` carries the server's `{ error }` text when it sent one.
      return { ok: false, error: error.message };
    }
    throw error;
  }
}

export function useCreateRun(client: ApiClient = dashboardClient) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { projectId: number; label?: string }) =>
      createRun(
        {
          projectId: input.projectId,
          ...(input.label ? { label: input.label } : {}),
        },
        client,
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: runKeys.lists() }),
  });
}

export function useEnqueue(client: ApiClient = dashboardClient) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      runId,
      urls,
    }: {
      runId: number;
      urls: string[];
    }): Promise<EnqueueResult> => {
      // The backend requires at least one URL; fail before the round trip.
      if (urls.length === 0) {
        return Promise.reject(new Error("Add at least one URL."));
      }
      return settleConflict(() => enqueueItems(runId, urls, client));
    },
    // Item counts changed (and a 409 means our view is stale): refresh all.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: runKeys.all }),
  });
}

export function useImport(client: ApiClient = dashboardClient) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      file: File;
      runId?: number;
    }): Promise<ImportResult> =>
      settleConflict(() => importList(input, client)),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: runKeys.all }),
  });
}
