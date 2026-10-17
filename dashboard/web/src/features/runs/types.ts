import type { Run, RunDetail } from "@/lib/schemas";

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
  live?: LiveProgress;
  /** Most recent log lines (oldest first), capped at `MAX_LOG_LINES`. */
  logs?: LogLine[];
};
