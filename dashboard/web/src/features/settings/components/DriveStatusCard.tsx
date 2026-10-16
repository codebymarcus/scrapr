import { Text } from "@/components/atoms/Text";
import type { DriveStatus } from "@/lib/schemas";
import styles from "./SettingsPage.module.scss";

type DriveStatusCardProps = {
  status: DriveStatus;
};

export function DriveStatusCard({ status }: DriveStatusCardProps) {
  const { connected, credentialsPath, tokenPath, hint } = status;

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
          {connected ? "Connected" : "Not connected"}
        </Text>
      </div>

      {hint ? (
        <Text variant="body" tone="secondary">
          {hint}
        </Text>
      ) : null}

      {credentialsPath || tokenPath ? (
        <dl className={styles.paths}>
          {credentialsPath ? (
            <>
              <dt>Credentials</dt>
              <dd>
                <code className={styles.path}>{credentialsPath}</code>
              </dd>
            </>
          ) : null}
          {tokenPath ? (
            <>
              <dt>Token</dt>
              <dd>
                <code className={styles.path}>{tokenPath}</code>
              </dd>
            </>
          ) : null}
        </dl>
      ) : null}
    </section>
  );
}
