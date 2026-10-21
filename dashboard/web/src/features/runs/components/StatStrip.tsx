import styles from "./StatStrip.module.scss";

type StatStripProps = {
  running: number;
  queuedItems: number;
  doneToday: number;
  /** `null` when the figure is not available from the API. */
  failingHosts: number | null;
};

export function StatStrip({
  running,
  queuedItems,
  doneToday,
  failingHosts,
}: StatStripProps) {
  const stats: { label: string; value: number | null }[] = [
    { label: "Running", value: running },
    { label: "Queued items", value: queuedItems },
    { label: "Done today", value: doneToday },
    { label: "Failing hosts", value: failingHosts },
  ];

  return (
    <dl role="group" aria-label="Run stats" className={styles.strip}>
      {stats.map((stat) => (
        <div key={stat.label} className={styles.stat}>
          <dt className={styles.label}>{stat.label}</dt>
          <dd className={styles.value}>{stat.value ?? "-"}</dd>
        </div>
      ))}
    </dl>
  );
}
