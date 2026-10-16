import styles from "./SegmentedMeter.module.scss";

type SegmentedMeterProps = {
  value: number;
  total: number;
  tone?: "accent" | "warn";
  segments?: number;
  label?: string;
};

function safeTotal(total: number): number {
  return Number.isFinite(total) && total > 0 ? total : 0;
}

function safeValue(value: number, total: number): number {
  if (total <= 0 || !Number.isFinite(value)) {
    return 0;
  }
  return Math.min(total, Math.max(0, value));
}

// LED-style meter: discrete blocks in an inset groove, lit left to right.
export function SegmentedMeter({
  value,
  total,
  tone = "accent",
  segments = 22,
  label,
}: SegmentedMeterProps) {
  const max = safeTotal(total);
  const now = safeValue(value, max);
  const lit = max > 0 ? Math.round((now / max) * segments) : 0;

  return (
    <div
      className={`${styles.meter} ${styles[tone]}`}
      role="progressbar"
      aria-label={label}
      aria-valuenow={now}
      aria-valuemin={0}
      aria-valuemax={max}
    >
      {Array.from({ length: segments }, (_, index) => (
        <span
          key={index}
          className={styles.segment}
          data-lit={index < lit ? "true" : "false"}
        />
      ))}
    </div>
  );
}
