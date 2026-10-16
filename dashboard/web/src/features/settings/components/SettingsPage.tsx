import { Text } from "@/components/atoms/Text";
import { ErrorState } from "@/components/molecules/ErrorState";
import { PageLayout } from "@/components/templates/PageLayout";
import { dashboardClient } from "@/lib/api-client";
import type { ApiClient } from "@/lib/http/api-client";
import { useDriveStatus } from "../hooks/use-drive-status";
import { AppearanceCard } from "./AppearanceCard";
import { DriveStatusCard } from "./DriveStatusCard";
import styles from "./SettingsPage.module.scss";

type SettingsPageProps = {
  /** Injectable for tests; production uses the shared dashboard client. */
  client?: ApiClient;
};

export function SettingsPage({ client = dashboardClient }: SettingsPageProps) {
  const driveQuery = useDriveStatus(client);

  function renderDrive() {
    if (driveQuery.isPending) {
      return (
        <div className={styles.skeleton} aria-busy="true">
          <Text variant="body" tone="secondary" role="status">
            Checking Drive status…
          </Text>
        </div>
      );
    }

    if (driveQuery.isError) {
      return (
        <ErrorState
          title="Couldn't load Drive status."
          message={driveQuery.error.message}
          onRetry={() => void driveQuery.refetch()}
          isRetrying={driveQuery.isFetching}
        />
      );
    }

    return <DriveStatusCard status={driveQuery.data} />;
  }

  return (
    <PageLayout
      title="Settings"
      subtitle="Google Drive status and how the dashboard looks."
    >
      <div className={styles.stack}>
        {renderDrive()}
        <AppearanceCard />
      </div>
    </PageLayout>
  );
}
