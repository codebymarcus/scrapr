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

/** Cached run detail: the server shape plus live socket-only data. */
export type CachedRunDetail = RunDetail & {
  live?: LiveProgress;
};
