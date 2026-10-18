import type { RunSummary as Summary } from "@/lib/schemas";
import styles from "./RunSummary.module.scss";

const UNITS = ["B", "KB", "MB", "GB", "TB"];

/** Bytes as B/KB/MB/GB (1024-based), at most one decimal. */
export function formatBytes(bytes: number): string {
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = unit === 0 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${UNITS[unit]}`;
}

/** Milliseconds as "1h 2m 3s", omitting leading zero units. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const parts: string[] = [];
  if (hours > 0) {
    parts.push(`${hours}h`);
  }
  if (hours > 0 || minutes > 0) {
    parts.push(`${minutes}m`);
  }
  parts.push(`${seconds}s`);
  return parts.join(" ");
}

type RunSummaryProps = { summary: Summary };

export function RunSummary({ summary }: RunSummaryProps) {
  const { counts } = summary;
  const stats: Array<[string, string]> = [
    [
      "Duration",
      summary.durationMs === null ? "—" : formatDuration(summary.durationMs),
    ],
    [
      "Outcome",
      `${counts.completed} completed · ${counts.failed} failed · ${counts.skipped} skipped · ${counts.uploaded} uploaded of ${counts.total}`,
    ],
    ["Uploaded", formatBytes(summary.uploadedSize)],
    ["Pages", String(summary.pages)],
    ["Downloaded", formatBytes(summary.bytesDownloaded)],
  ];
  if (summary.cost > 0) {
    stats.push(["Cost", `~$${summary.cost.toFixed(2)} est.`]);
  }

  return (
    <dl className={styles.summary} aria-label="Run summary">
      {stats.map(([label, value]) => (
        <div key={label} className={styles.stat}>
          <dt className={styles.label}>{label}</dt>
          <dd className={styles.value}>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
