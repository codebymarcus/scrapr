import { Text } from "@/components/atoms/Text";
import { ErrorState } from "@/components/molecules/ErrorState";
import { PageLayout } from "@/components/templates/PageLayout";
import { dashboardClient } from "@/lib/api-client";
import type { ApiClient } from "@/lib/http/api-client";
import { useDriveAccounts } from "../hooks/use-drive-accounts";
import { AppearanceCard } from "./AppearanceCard";
import { DriveAccountsCard } from "./DriveAccountsCard";
import styles from "./SettingsPage.module.scss";

type SettingsPageProps = {
  /** Injectable for tests; production uses the shared dashboard client. */
  client?: ApiClient;
};

export function SettingsPage({ client = dashboardClient }: SettingsPageProps) {
  const driveQuery = useDriveAccounts(client);

  function renderDrive() {
    if (driveQuery.isPending) {
      return (
        <div className={styles.skeleton} aria-busy="true">
          <Text variant="body" tone="secondary" role="status">
            Checking Drive accounts…
          </Text>
        </div>
      );
    }

    if (driveQuery.isError) {
      return (
        <ErrorState
          title="Couldn't load Drive accounts."
          message={driveQuery.error.message}
          onRetry={() => void driveQuery.refetch()}
          isRetrying={driveQuery.isFetching}
        />
      );
    }

    return <DriveAccountsCard data={driveQuery.data} client={client} />;
  }

  return (
    <PageLayout
      title="Settings"
      subtitle="Google Drive accounts and how the dashboard looks."
    >
      <div className={styles.stack}>
        {renderDrive()}
        <AppearanceCard />
      </div>
    </PageLayout>
  );
}
