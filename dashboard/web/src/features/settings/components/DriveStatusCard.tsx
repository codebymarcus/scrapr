import { Button } from "@/components/atoms/Button";
import { Text } from "@/components/atoms/Text";
import { dashboardClient } from "@/lib/api-client";
import type { ApiClient } from "@/lib/http/api-client";
import type { DriveStatus } from "@/lib/schemas";
import { useDriveMutations } from "../hooks/use-drive-status";
import styles from "./SettingsPage.module.scss";

type DriveStatusCardProps = {
  status: DriveStatus;
  /** Injectable for tests; production uses the shared dashboard client. */
  client?: ApiClient;
};

export function DriveStatusCard({
  status,
  client = dashboardClient,
}: DriveStatusCardProps) {
  const { connected, configured, hint } = status;
  const { connect, disconnect } = useDriveMutations(client);

  const statusLabel = connected
    ? "Connected"
    : configured
      ? "Not connected"
      : "Not configured";
  const error = connect.error ?? disconnect.error;

  return (
    <section className={styles.card} aria-labelledby="drive-status-title">
      <div className={styles.cardHeader}>
        <Text
          as="h2"
          variant="heading"
          id="drive-status-title"
          className={styles.cardTitle}
        >
          Google Drive
        </Text>
        <Text
          variant="small"
          weight="semibold"
          tone={connected ? "positive" : "negative"}
          role="status"
        >
          {statusLabel}
        </Text>
      </div>

      {!configured ? (
        <Text variant="body" tone="secondary">
          Google Drive isn&apos;t configured on the server. Set the Google
          OAuth client ID and secret environment variables, then restart the
          dashboard.
        </Text>
      ) : hint ? (
        <Text variant="body" tone="secondary">
          {hint}
        </Text>
      ) : null}

      {configured && !connected ? (
        <div className={styles.actions}>
          <Button
            variant="primary"
            onClick={() => connect.mutate()}
            disabled={connect.isPending}
          >
            Connect Google Drive
          </Button>
        </div>
      ) : null}

      {connected ? (
        <div className={styles.actions}>
          <Button
            onClick={() => disconnect.mutate()}
            disabled={disconnect.isPending}
          >
            Disconnect
          </Button>
        </div>
      ) : null}

      {error ? (
        <Text variant="body" tone="negative" role="alert">
          {error.message}
        </Text>
      ) : null}
    </section>
  );
}
