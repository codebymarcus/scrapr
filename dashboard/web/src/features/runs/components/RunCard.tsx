import { useEffect, useId, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/atoms/Badge";
import { Button } from "@/components/atoms/Button";
import { ListIcon } from "@/components/atoms/icons/ListIcon";
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
import { RunConsole } from "./RunConsole";
import { RunItemsPanel } from "./RunItemsPanel";
import { RunSummary } from "./RunSummary";

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
  // A finished run shows its summary; the Items panel needs the detail in
  // any state once expanded. A finished run is fetched once, never polled.
  const isFinished =
    run.state === "done" || run.state === "failed" || run.state === "stopped";
  const [itemsOpen, setItemsOpen] = useState(false);
  const itemsId = useId();
  const detail = useRun(
    isRunning || isFinished || itemsOpen ? run.id : null,
    client,
    {
      refetchInterval: isRunning && !connected ? POLL_INTERVAL_MS : false,
    },
  );
  const polledState = detail.data?.run.state;
  useEffect(() => {
    // Polling sees a state change the (list) run prop hasn't caught up with.
    if (isRunning && !connected && polledState && polledState !== run.state) {
      void queryClient.invalidateQueries({ queryKey: runKeys.lists() });
    }
  }, [isRunning, connected, polledState, run.state, queryClient]);

  const [consoleOpen, setConsoleOpen] = useState(false);
  const consoleId = useId();
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const { start, stop, resume, remove } = useRunActions(client, {
    onFailure: onActionError,
  });
  const busy = [start, stop, resume, remove].some(
    (mutation) => mutation.isPending,
  );

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

      {isFinished && detail.data?.summary ? (
        <RunSummary summary={detail.data.summary} />
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
        <Button
          className={styles.itemsToggle}
          aria-expanded={itemsOpen}
          aria-controls={itemsId}
          onClick={() => setItemsOpen((open) => !open)}
        >
          Items
        </Button>
        {isRunning ? (
          <Button
            aria-expanded={consoleOpen}
            aria-controls={consoleId}
            onClick={() => setConsoleOpen((open) => !open)}
          >
            <ListIcon />
            Console
          </Button>
        ) : null}
        {/* Delete: only for non-running runs; a running run must be stopped first. */}
        {!isRunning && !confirmingDelete ? (
          <Button
            className={styles.delete}
            disabled={busy}
            aria-label={`Delete ${name}`}
            onClick={() => {
              onActionError?.(run.id, null);
              setConfirmingDelete(true);
            }}
          >
            Delete
          </Button>
        ) : null}
        {!isRunning && confirmingDelete ? (
          <>
            <Button
              className={styles.confirmDelete}
              disabled={busy}
              aria-label={`Confirm delete ${name}`}
              onClick={() =>
                remove.mutate(run.id, {
                  onSettled: () => setConfirmingDelete(false),
                })
              }
            >
              Confirm delete
            </Button>
            <Button
              disabled={busy}
              aria-label={`Cancel delete ${name}`}
              onClick={() => setConfirmingDelete(false)}
            >
              Cancel
            </Button>
          </>
        ) : null}
      </div>

      {itemsOpen ? (
        <div id={itemsId} className={styles.items}>
          <RunItemsPanel
            runId={run.id}
            items={detail.data?.items ?? []}
            contentType={contentType ?? "text"}
            isRunning={isRunning}
            liveByItem={detail.data?.liveByItem}
            client={client}
          />
        </div>
      ) : null}

      {isRunning && consoleOpen ? (
        <div id={consoleId} className={styles.console}>
          <RunConsole logs={detail.data?.logs ?? []} />
        </div>
      ) : null}

      {actionError ? (
        <Text variant="small" tone="negative" role="alert">
          {actionError}
        </Text>
      ) : null}
    </article>
  );
}
