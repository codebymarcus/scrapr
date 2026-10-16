import { useQueries } from "@tanstack/react-query";
import { dashboardClient } from "@/lib/api-client";
import type { ApiClient } from "@/lib/http/api-client";
import { retryApiQuery } from "@/lib/query-retry";
import type { Run, RunDetail } from "@/lib/schemas";
import { fetchRun } from "../api/runs-api";
import type { RunProgress } from "../types";
import { runKeys } from "./runs-keys";

export function deriveProgress(detail: RunDetail): RunProgress {
  const done = detail.items.filter((item) => item.saved != null).length;
  return { done, total: detail.items.length };
}

// The list endpoint carries no item counts, so fetch the detail of each
// given run (shares the `runKeys.detail` cache with `useRun`) and derive
// progress. Returns a map keyed by run id for the runs whose detail loaded.
export function useRunProgress(
  runs: Run[],
  client: ApiClient = dashboardClient,
): Map<number, RunProgress> {
  return useQueries({
    queries: runs.map((run) => ({
      queryKey: runKeys.detail(run.id),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        fetchRun(run.id, signal, client),
      retry: retryApiQuery,
    })),
    combine: (results) => {
      const progress = new Map<number, RunProgress>();
      results.forEach((result, index) => {
        if (result.data) {
          progress.set(runs[index].id, deriveProgress(result.data));
        }
      });
      return progress;
    },
  });
}
