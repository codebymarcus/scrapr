import type { Run } from "@/lib/schemas";

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
