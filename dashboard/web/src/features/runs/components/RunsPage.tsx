import { useCallback, useState } from "react";
import { Button } from "@/components/atoms/Button";
import { Text } from "@/components/atoms/Text";
import { ErrorState } from "@/components/molecules/ErrorState";
import { PageLayout } from "@/components/templates/PageLayout";
import { dashboardClient } from "@/lib/api-client";
import type { ApiClient } from "@/lib/http/api-client";
import type { SocketFactory } from "../hooks/use-run-events";
import { useRunProgress } from "../hooks/use-run-progress";
import { useRuns } from "../hooks/use-runs";
import { groupRuns, isSameLocalDay } from "../utils";
import { RunCard } from "./RunCard";
import { ImportListDialog } from "./ImportListDialog";
import { NewRunDialog } from "./NewRunDialog";
import { RunGroup } from "./RunGroup";
import { StatStrip } from "./StatStrip";
import styles from "./RunsPage.module.scss";

type RunsPageProps = {
  /** Injectable for tests; production uses the shared dashboard client. */
  client?: ApiClient;
  /** Injectable for tests; production opens real WebSockets. */
  socketFactory?: SocketFactory;
};

export function RunsPage({
  client = dashboardClient,
  socketFactory,
}: RunsPageProps) {
  const runsQuery = useRuns(client);

  // Action failures live here, keyed by run id, so a message survives the
  // card remounting when a refetch moves it to another group.
  const [actionErrors, setActionErrors] = useState<Record<number, string>>({});
  const handleActionError = useCallback(
    (runId: number, message: string | null) => {
      setActionErrors((current) => {
        if (message === null) {
          if (!(runId in current)) {
            return current;
          }
          const rest = { ...current };
          delete rest[runId];
          return rest;
        }
        return { ...current, [runId]: message };
      });
    },
    [],
  );
  const runs = runsQuery.data ?? [];
  const groups = groupRuns(runs);

  // Only unfinished runs need item counts (queued items + live progress).
  const progress = useRunProgress(
    [...groups.running, ...groups.queued, ...groups.stopped],
    client,
  );

  const [dialog, setDialog] = useState<"new" | "import" | null>(null);
  const closeDialog = useCallback(() => setDialog(null), []);

  const headerActions = (
    <>
      <Button variant="primary" onClick={() => setDialog("new")}>
        + New run
      </Button>
      <Button onClick={() => setDialog("import")}>Import list</Button>
    </>
  );

  function renderBody() {
    if (runsQuery.isPending) {
      return (
        <div className={styles.skeleton} aria-busy="true">
          <Text variant="body" tone="secondary" role="status">
            Loading runs…
          </Text>
        </div>
      );
    }

    if (runsQuery.isError) {
      return (
        <ErrorState
          title="Couldn't load runs."
          message={runsQuery.error.message}
          onRetry={() => void runsQuery.refetch()}
          isRetrying={runsQuery.isFetching}
        />
      );
    }

    if (runs.length === 0) {
      return (
        <section className={styles.empty}>
          <Text variant="heading" as="h2">
            No runs yet
          </Text>
          <Text variant="body" tone="secondary">
            Start a new run, or import a list of URLs to scrape.
          </Text>
        </section>
      );
    }

    const now = new Date();
    const pendingItems = [...groups.running, ...groups.queued].reduce(
      (sum, run) => {
        const p = progress.get(run.id);
        return p ? sum + (p.total - p.done) : sum;
      },
      0,
    );
    const doneToday = groups.recent.filter(
      (run) => run.state === "done" && isSameLocalDay(run.finished_at, now),
    ).length;

    const renderCards = (list: typeof runs) =>
      list.map((run) => (
        <RunCard
          key={run.id}
          run={run}
          progress={progress.get(run.id)}
          actionError={actionErrors[run.id]}
          onActionError={handleActionError}
          client={client}
          socketFactory={socketFactory}
        />
      ));

    return (
      <>
        <StatStrip
          running={groups.running.length}
          queuedItems={pendingItems}
          doneToday={doneToday}
          // Per-host failures are not exposed by the API yet: show "—".
          failingHosts={null}
        />
        <RunGroup label="Running">{renderCards(groups.running)}</RunGroup>
        <RunGroup label="Queued">{renderCards(groups.queued)}</RunGroup>
        <RunGroup label="Stopped — resumable">
          {renderCards(groups.stopped)}
        </RunGroup>
        <RunGroup label="Recent">{renderCards(groups.recent)}</RunGroup>
      </>
    );
  }

  return (
    <PageLayout
      title="Runs"
      subtitle="Scrape jobs in flight and recently finished."
      actions={headerActions}
    >
      {renderBody()}
      {dialog === "new" ? (
        <NewRunDialog client={client} onClose={closeDialog} />
      ) : null}
      {dialog === "import" ? (
        <ImportListDialog client={client} onClose={closeDialog} />
      ) : null}
    </PageLayout>
  );
}
