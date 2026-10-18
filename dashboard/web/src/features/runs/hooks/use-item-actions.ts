import { useMutation, useQueryClient } from "@tanstack/react-query";
import { dashboardClient } from "@/lib/api-client";
import { ApiError } from "@/lib/http/api-error";
import type { ApiClient } from "@/lib/http/api-client";
import {
  deleteItem,
  retryItem,
  retryRun,
  uploadItem,
  uploadPending,
} from "../api/runs-api";
import { runKeys } from "./runs-keys";

/**
 * A conflict (409: run running, Drive not connected, no output) is an expected
 * outcome, so it is data carrying the server's message, not a throw.
 */
export type ItemActionResult<T = undefined> =
  | { ok: true; data: T }
  | { ok: false; error: string };

async function settle<T>(action: () => Promise<T>): Promise<ItemActionResult<T>> {
  try {
    return { ok: true, data: await action() };
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

export type RunInput = { runId: number };
export type ItemInput = { runId: number; itemId: number };

export function useItemActions(client: ApiClient = dashboardClient) {
  const queryClient = useQueryClient();
  // Refresh the run's detail and the lists (counts/state) once the call settles,
  // including on a 409, since the cached state is probably stale then.
  const refresh = async (_result: unknown, { runId }: RunInput) => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: runKeys.detail(runId) }),
      queryClient.invalidateQueries({ queryKey: runKeys.lists() }),
    ]);
  };

  const remove = useMutation({
    mutationFn: ({ runId, itemId }: ItemInput) =>
      settle(() => deleteItem(runId, itemId, client)),
    onSuccess: refresh,
  });
  const upload = useMutation({
    mutationFn: ({ runId, itemId }: ItemInput) =>
      settle(() => uploadItem(runId, itemId, client)),
    onSuccess: refresh,
  });
  const uploadAllPending = useMutation({
    mutationFn: ({ runId }: RunInput) =>
      settle(() => uploadPending(runId, client)),
    onSuccess: refresh,
  });
  // Retry every failed item in the run.
  const retry = useMutation({
    mutationFn: ({ runId }: RunInput) => settle(() => retryRun(runId, client)),
    onSuccess: refresh,
  });
  const retryOne = useMutation({
    mutationFn: ({ runId, itemId }: ItemInput) =>
      settle(() => retryItem(runId, itemId, client)),
    onSuccess: refresh,
  });

  return {
    remove,
    upload,
    uploadPending: uploadAllPending,
    retry,
    retryItem: retryOne,
  };
}
