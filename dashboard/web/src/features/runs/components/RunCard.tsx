import type { ReactNode } from "react";
import { Badge } from "@/components/atoms/Badge";
import { SegmentedMeter } from "@/components/atoms/SegmentedMeter";
import { Text } from "@/components/atoms/Text";
import type { Run } from "@/lib/schemas";
import type { RunContentType, RunProgress } from "../types";
import { runName } from "../utils";
import styles from "./RunCard.module.scss";

type RunCardProps = {
  run: Run;
  /** Known from the run's project; falls back to the project id. */
  contentType?: RunContentType;
  /** Item counts; the list endpoint has none, so this is derived upstream. */
  progress?: RunProgress;
  /** Action buttons (wired up by the run-controls feature). */
  actions?: ReactNode;
};

export function RunCard({ run, contentType, progress, actions }: RunCardProps) {
  const showMeter = progress !== undefined || run.state === "running";
  const counts = progress ? `${progress.done} of ${progress.total}` : null;

  return (
    <article className={styles.card}>
      <div className={styles.top}>
        <Text variant="body" as="h3" weight="semibold" className={styles.name}>
          {runName(run)}
        </Text>
        <span className={styles.tag}>
          {contentType ?? `project ${run.project_id}`}
        </span>
        <Badge tone={run.state} />
      </div>

      {showMeter ? (
        <div className={styles.progress}>
          <SegmentedMeter
            value={progress?.done ?? 0}
            total={progress?.total ?? 0}
            tone={run.state === "stopped" ? "warn" : "accent"}
            label={counts ?? "Progress unavailable"}
          />
          <span className={styles.counts}>
            {counts ? `${counts} items` : "—"}
          </span>
        </div>
      ) : null}

      <div className={styles.actions}>{actions}</div>
    </article>
  );
}
