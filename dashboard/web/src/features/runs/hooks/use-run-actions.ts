import { useMutation, useQueryClient } from "@tanstack/react-query";
import { dashboardClient } from "@/lib/api-client";
import { ApiError } from "@/lib/http/api-error";
import type { ApiClient } from "@/lib/http/api-client";
import { startRun, stopRun } from "../api/runs-api";
import { runKeys } from "./runs-keys";

/** A conflict (409) is an expected outcome, so it is data, not a throw. */
export type RunActionResult = { ok: true } | { ok: false; error: string };

async function settle(action: () => Promise<void>): Promise<RunActionResult> {
  try {
    await action();
    return { ok: true };
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

type UseRunActionsOptions = {
  /**
   * Called with the failure message (a 409 conflict or any other error).
   * Lets the owner keep the message outside the card, which can remount when
   * the refreshed list regroups it.
   */
  onFailure?: (runId: number, message: string) => void;
};

export function useRunActions(
  client: ApiClient = dashboardClient,
  { onFailure }: UseRunActionsOptions = {},
) {
  const queryClient = useQueryClient();
  const refresh = (result: RunActionResult, id: number) => {
    if (!result.ok) {
      onFailure?.(id, result.error);
    }
    return queryClient.invalidateQueries({ queryKey: runKeys.all });
  };
  const fail = (error: Error, id: number) => onFailure?.(id, error.message);

  const start = useMutation({
    mutationFn: (id: number) => settle(() => startRun(id, client)),
    onSuccess: refresh,
    onError: fail,
  });
  const stop = useMutation({
    mutationFn: (id: number) => settle(() => stopRun(id, client)),
    onSuccess: refresh,
    onError: fail,
  });
  // The server resumes a stopped run through the same endpoint as a start.
  const resume = useMutation({
    mutationFn: (id: number) => settle(() => startRun(id, client)),
    onSuccess: refresh,
    onError: fail,
  });

  return { start, stop, resume };
}
