import { useState } from "react";
import { Button } from "@/components/atoms/Button";
import { Label } from "@/components/atoms/Label";
import { Text } from "@/components/atoms/Text";
import { TextInput } from "@/components/atoms/TextInput";
import { dashboardClient } from "@/lib/api-client";
import type { ApiClient } from "@/lib/http/api-client";
import type { DriveAccount, DriveAccounts } from "@/lib/schemas";
import {
  useConnectDrive,
  useDisconnectAccount,
  useRenameAccount,
} from "../hooks/use-drive-accounts";
import styles from "./SettingsPage.module.scss";

type DriveAccountsCardProps = {
  data: DriveAccounts;
  /** Injectable for tests; production uses the shared dashboard client. */
  client?: ApiClient;
};

export function DriveAccountsCard({
  data,
  client = dashboardClient,
}: DriveAccountsCardProps) {
  const { configured, accounts } = data;
  const connect = useConnectDrive(client);

  return (
    <section className={styles.card} aria-labelledby="drive-accounts-title">
      <div className={styles.cardHeader}>
        <Text
          as="h2"
          variant="heading"
          id="drive-accounts-title"
          className={styles.cardTitle}
        >
          Google Drive
        </Text>
      </div>

      {!configured ? (
        <Text variant="body" tone="secondary">
          Google Drive isn&apos;t configured on the server. Set the Google
          OAuth client ID and secret environment variables, then restart the
          dashboard.
        </Text>
      ) : (
        <>
          {accounts.length > 0 ? (
            <ul className={styles.accounts}>
              {accounts.map((account) => (
                <DriveAccountItem
                  key={account.id}
                  account={account}
                  client={client}
                  onReconnect={() => connect.mutate(account.id)}
                  reconnecting={connect.isPending}
                />
              ))}
            </ul>
          ) : (
            <Text variant="body" tone="secondary">
              No Google Drive connected yet.
            </Text>
          )}

          <div className={styles.actions}>
            <Button
              variant="primary"
              onClick={() => connect.mutate(undefined)}
              disabled={connect.isPending}
            >
              {accounts.length > 0
                ? "Connect another Drive"
                : "Connect Google Drive"}
            </Button>
          </div>

          {connect.error ? (
            <Text variant="body" tone="negative" role="alert">
              {connect.error.message}
            </Text>
          ) : null}
        </>
      )}
    </section>
  );
}

type DriveAccountItemProps = {
  account: DriveAccount;
  client: ApiClient;
  onReconnect: () => void;
  reconnecting: boolean;
};

function accountName(account: DriveAccount): string {
  return account.label ?? account.email ?? "Drive account";
}

function DriveAccountItem({
  account,
  client,
  onReconnect,
  reconnecting,
}: DriveAccountItemProps) {
  const disconnect = useDisconnectAccount(account.id, client);
  const rename = useRenameAccount(account.id, client);
  const [draft, setDraft] = useState<string | null>(null);

  const name = accountName(account);
  const inputId = `drive-account-name-${account.id}`;
  const error = disconnect.error ?? rename.error;
  const trimmed = draft?.trim() ?? "";

  function save() {
    if (trimmed === "") return;
    rename.mutate(trimmed, { onSuccess: () => setDraft(null) });
  }

  return (
    <li className={styles.account}>
      <div className={styles.cardHeader}>
        {draft === null ? (
          <div className={styles.accountName}>
            <Text as="h3" variant="body" weight="semibold">
              {name}
            </Text>
            {account.email && account.email !== name ? (
              <Text variant="small" tone="secondary">
                {account.email}
              </Text>
            ) : null}
          </div>
        ) : (
          <form
            className={styles.renameForm}
            onSubmit={(event) => {
              event.preventDefault();
              save();
            }}
          >
            <Label htmlFor={inputId}>Account name</Label>
            <TextInput
              id={inputId}
              value={draft}
              onChange={setDraft}
              disabled={rename.isPending}
            />
            <div className={styles.actions}>
              <Button
                variant="primary"
                onClick={save}
                disabled={trimmed === "" || rename.isPending}
              >
                Save
              </Button>
              <Button
                onClick={() => {
                  rename.reset();
                  setDraft(null);
                }}
                disabled={rename.isPending}
              >
                Cancel
              </Button>
            </div>
          </form>
        )}
        <Text
          variant="small"
          weight="semibold"
          tone={account.connected ? "positive" : "negative"}
          role="status"
        >
          {account.connected ? "Connected" : "Needs reconnect"}
        </Text>
      </div>

      {draft === null ? (
        <div className={styles.actions}>
          <Button
            aria-label={`Rename ${name}`}
            onClick={() => setDraft(account.label ?? "")}
          >
            Rename
          </Button>
          <Button
            aria-label={`Reconnect ${name}`}
            onClick={onReconnect}
            disabled={reconnecting}
          >
            Reconnect
          </Button>
          <Button
            aria-label={`Disconnect ${name}`}
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
    </li>
  );
}
