import styles from "./Badge.module.scss";

type BadgeTone = "queued" | "running" | "stopped" | "done" | "failed" | "review";

type BadgeProps = {
  tone: BadgeTone;
};

const LABELS: Record<BadgeTone, string> = {
  queued: "Queued",
  running: "Running",
  stopped: "Stopped",
  done: "Done",
  failed: "Failed",
  review: "Review",
};

export function Badge({ tone }: BadgeProps) {
  return (
    <span className={`${styles.badge} ${styles[tone]}`}>{LABELS[tone]}</span>
  );
}
