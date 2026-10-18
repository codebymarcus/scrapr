import { DEFAULTS } from "../../../src/config.mjs";

// Server-side mirror of the web `deriveItemStatus` contract:
//   completed = saved recorded & status "done"; failed = status "retry", or a
//   recorded reason on a non-completed, non-skipped row; skipped = status "skip"
//   or a "skipped:" reason; otherwise pending.
function itemStatus(item) {
  if (item.saved != null && item.status === "done") return "completed";
  if (item.status === "retry") return "failed";
  if (item.status === "skip" || item.reason?.startsWith("skipped:")) return "skipped";
  if (item.reason) return "failed";
  return "pending";
}

function durationOf(run) {
  if (!run?.started_at || !run?.finished_at) return null;
  const ms = Date.parse(run.finished_at) - Date.parse(run.started_at);
  return Number.isFinite(ms) ? ms : null;
}

// Aggregate stats for a run detail view. Null-safe: missing numeric fields count as 0.
// cost = downloaded GB * costPerGb (0 when no rate is configured).
export function summarizeRun(run, items, { costPerGb = DEFAULTS.costPerGb } = {}) {
  const counts = { total: items.length, completed: 0, failed: 0, skipped: 0, uploaded: 0 };
  let pages = 0;
  let uploadedSize = 0;
  let bytesDownloaded = 0;
  for (const item of items) {
    const status = itemStatus(item);
    if (status !== "pending") counts[status] += 1;
    pages += item.saved ?? 0;
    bytesDownloaded += item.bytes ?? 0;
    if (item.uploaded_at != null) {
      counts.uploaded += 1;
      uploadedSize += item.output_size ?? 0;
    }
  }
  return {
    durationMs: durationOf(run),
    counts,
    pages,
    uploadedSize,
    bytesDownloaded,
    cost: (bytesDownloaded / 1e9) * (costPerGb ?? 0),
  };
}
