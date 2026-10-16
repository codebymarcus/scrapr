import type { Run } from "@/lib/schemas";
import type { RunGroups } from "./types";

export function groupRuns(runs: Run[]): RunGroups {
  const byIdAsc = [...runs].sort((a, b) => a.id - b.id);
  return {
    running: byIdAsc.filter((run) => run.state === "running"),
    queued: byIdAsc.filter((run) => run.state === "queued"),
    stopped: byIdAsc.filter((run) => run.state === "stopped"),
    // Newest first.
    recent: byIdAsc
      .filter((run) => run.state === "done" || run.state === "failed")
      .reverse(),
  };
}

export function isSameLocalDay(iso: string | null | undefined, now: Date) {
  if (!iso) {
    return false;
  }
  const date = new Date(iso);
  return (
    !Number.isNaN(date.getTime()) &&
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  );
}

export function runName(run: Run): string {
  return run.label?.trim() ? run.label : `Run #${run.id}`;
}
