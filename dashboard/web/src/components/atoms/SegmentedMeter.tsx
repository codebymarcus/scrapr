import styles from "./SegmentedMeter.module.scss";

type SegmentedMeterProps = {
  value: number;
  total: number;
  tone?: "accent" | "warn";
  segments?: number;
};

function litSegments(value: number, total: number, segments: number): number {
  if (total <= 0) {
    return 0;
  }
  const lit = Math.round((value / total) * segments);
  return Math.min(segments, Math.max(0, lit));
}

// LED-style meter: discrete blocks in an inset groove, lit left to right.
export function SegmentedMeter({
  value,
  total,
  tone = "accent",
  segments = 22,
}: SegmentedMeterProps) {
  const lit = litSegments(value, total, segments);

  return (
    <div
      className={`${styles.meter} ${styles[tone]}`}
      role="progressbar"
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={total}
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
