import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/atoms/Badge";
import { Button } from "@/components/atoms/Button";
import { PlayIcon } from "@/components/atoms/icons/PlayIcon";
import { StopIcon } from "@/components/atoms/icons/StopIcon";
import { SegmentedMeter } from "@/components/atoms/SegmentedMeter";
import { Text } from "@/components/atoms/Text";
import { dashboardClient } from "@/lib/api-client";
import type { ApiClient } from "@/lib/http/api-client";
import type { Run } from "@/lib/schemas";
import { runKeys } from "../hooks/runs-keys";
import { useRun } from "../hooks/use-run";
import { useRunActions } from "../hooks/use-run-actions";
import { useRunEvents } from "../hooks/use-run-events";
import type { SocketFactory } from "../hooks/use-run-events";
import type { RunContentType, RunProgress } from "../types";
import { runName } from "../utils";
import styles from "./RunCard.module.scss";

// Poll the run detail at this cadence while the live socket is down.
const POLL_INTERVAL_MS = 3000;

type RunCardProps = {
  run: Run;
  /** Known from the run's project; the tag is hidden when unknown. */
  contentType?: RunContentType;
  /** Item counts; the list endpoint has none, so this is derived upstream. */
  progress?: RunProgress;
  /**
   * Last action failure for this run. Owned by the page, not the card: the
   * card can remount when the refreshed list regroups it.
   */
  actionError?: string | null;
  /** Reports an action failure (message) or clears it (null). */
  onActionError?: (runId: number, message: string | null) => void;
  /** Injectable for tests; production uses the shared dashboard client. */
  client?: ApiClient;
  /** Injectable for tests; production opens a real WebSocket. */
  socketFactory?: SocketFactory;
};

export function RunCard({
  run,
  contentType,
  progress,
  actionError,
  onActionError,
  client = dashboardClient,
  socketFactory,
}: RunCardProps) {
  const queryClient = useQueryClient();
  const isRunning = run.state === "running";

  // A running card streams its events into the cache; when the socket is
  // down it polls the detail instead so the card still moves.
  const { connected } = useRunEvents(run.id, {
    enabled: isRunning,
    socketFactory,
  });
  const detail = useRun(isRunning ? run.id : null, client, {
    refetchInterval: connected ? false : POLL_INTERVAL_MS,
  });
  const polledState = detail.data?.run.state;
  useEffect(() => {
    // Polling sees a state change the (list) run prop hasn't caught up with.
    if (isRunning && !connected && polledState && polledState !== run.state) {
      void queryClient.invalidateQueries({ queryKey: runKeys.lists() });
    }
  }, [isRunning, connected, polledState, run.state, queryClient]);

  const { start, stop, resume } = useRunActions(client, {
    onFailure: onActionError,
  });
  const busy = [start, stop, resume].some((mutation) => mutation.isPending);

  function fire(mutation: typeof start) {
    onActionError?.(run.id, null);
    mutation.mutate(run.id);
  }

  const name = runName(run);

  const showMeter = progress !== undefined || isRunning;
  const counts = progress ? `${progress.done} of ${progress.total}` : null;

  return (
    <article className={styles.card}>
      <div className={styles.top}>
        <Text variant="body" as="h3" weight="semibold" className={styles.name}>
          {name}
        </Text>
        {contentType ? <span className={styles.tag}>{contentType}</span> : null}
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

      <div className={styles.actions}>
        {run.state === "queued" ? (
          <Button
            variant="primary"
            disabled={busy}
            aria-label={`Start ${name}`}
            onClick={() => fire(start)}
          >
            <PlayIcon />
            Start
          </Button>
        ) : null}
        {run.state === "stopped" ? (
          <Button
            variant="primary"
            disabled={busy}
            aria-label={`Resume ${name}`}
            onClick={() => fire(resume)}
          >
            <PlayIcon />
            Resume
          </Button>
        ) : null}
        {isRunning ? (
          <Button
            disabled={busy}
            aria-label={`Stop ${name}`}
            onClick={() => fire(stop)}
          >
            <StopIcon />
            Stop
          </Button>
        ) : null}
      </div>

      {actionError ? (
        <Text variant="small" tone="negative" role="alert">
          {actionError}
        </Text>
      ) : null}
    </article>
  );
}
