import type { Run, RunDetail, RunItem } from "@/lib/schemas";

/** Display status of one item, derived from its stored row. */
export type RunItemStatus = "completed" | "pending" | "skipped" | "failed";

export function deriveItemStatus(item: RunItem): RunItemStatus {
  if (item.saved != null && item.status === "done") {
    return "completed";
  }
  if (item.status === "retry") {
    return "failed";
  }
  if (item.status === "skip" || item.reason?.startsWith("skipped:")) {
    return "skipped";
  }
  // A recorded failure: a reason was stored and the item did not complete.
  if (item.reason) {
    return "failed";
  }
  return "pending";
}

export function isUploaded(item: RunItem): boolean {
  return item.uploaded_at != null;
}

export type RunProgress = {
  /** Items that have a recorded result. */
  done: number;
  /** All items in the run. */
  total: number;
};

export type RunContentType = "image" | "text";

export type RunGroups = {
  running: Run[];
  queued: Run[];
  stopped: Run[];
  recent: Run[];
};

/** The engine's most recent live counter, carried on the cached run detail. */
export type LiveProgress = {
  current: number;
  total: number;
  label?: string;
};

/** One retained engine log line, keyed by a monotonically increasing `seq`. */
export type LogLine = {
  seq: number;
  level?: string;
  message: string;
  ts?: number;
};

/** Cached run detail: the server shape plus live socket-only data. */
export type CachedRunDetail = RunDetail & {
  /** Latest live counter per in-flight item id (concurrent rows). */
  liveByItem?: Record<number, LiveProgress>;
  /** Most recent log lines (oldest first), capped at `MAX_LOG_LINES`. */
  logs?: LogLine[];
};
