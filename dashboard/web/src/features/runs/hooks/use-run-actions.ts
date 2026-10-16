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

export function useRunActions(client: ApiClient = dashboardClient) {
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: runKeys.all });

  const start = useMutation({
    mutationFn: (id: number) => settle(() => startRun(id, client)),
    onSuccess: refresh,
  });
  const stop = useMutation({
    mutationFn: (id: number) => settle(() => stopRun(id, client)),
    onSuccess: refresh,
  });
  // The server resumes a stopped run through the same endpoint as a start.
  const resume = useMutation({
    mutationFn: (id: number) => settle(() => startRun(id, client)),
    onSuccess: refresh,
  });

  return { start, stop, resume };
}
