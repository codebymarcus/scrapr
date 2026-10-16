import { useId, useState } from "react";
import { Button } from "@/components/atoms/Button";
import { Select } from "@/components/atoms/Select";
import { Text } from "@/components/atoms/Text";
import { TextInput } from "@/components/atoms/TextInput";
import { Field } from "@/components/molecules/Field";
import { Modal } from "@/components/molecules/Modal";
import { useProjects } from "@/features/projects";
import { dashboardClient } from "@/lib/api-client";
import type { ApiClient } from "@/lib/http/api-client";
import type { Run } from "@/lib/schemas";
import {
  useCreateRun,
  useEnqueue,
  useImport,
} from "../hooks/use-run-mutations";
import { useRuns } from "../hooks/use-runs";
import { projectOptions } from "./project-options";
import styles from "./RunDialogs.module.scss";

const NEW_RUN = "new";

type ImportListDialogProps = {
  onClose: () => void;
  /** Injectable for tests; production uses the shared dashboard client. */
  client?: ApiClient;
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}

function runOptionLabel(run: Run): string {
  const name = run.label ? `#${run.id} ${run.label}` : `Run #${run.id}`;
  return `${name} (${run.state})`;
}

type Imported = { added: number; runId: number };

export function ImportListDialog({
  onClose,
  client = dashboardClient,
}: ImportListDialogProps) {
  const ids = useId();
  const runsQuery = useRuns(client);
  const projectsQuery = useProjects(client);
  const importList = useImport(client);
  const createRun = useCreateRun(client);
  const enqueue = useEnqueue(client);

  const [file, setFile] = useState<File | null>(null);
  const [target, setTarget] = useState(NEW_RUN);
  const [projectId, setProjectId] = useState("");
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [imported, setImported] = useState<Imported | null>(null);
  // New-run mode reads the sheet before creating anything, so a bad file never
  // leaves an empty run behind. These survive a failed enqueue for the retry.
  const [sheetUrls, setSheetUrls] = useState<string[] | null>(null);
  const [createdRun, setCreatedRun] = useState<Run | null>(null);

  const busy = importList.isPending || createRun.isPending || enqueue.isPending;
  const isNew = target === NEW_RUN;
  const openRuns = (runsQuery.data ?? []).filter(
    (run) => run.state === "queued" || run.state === "stopped",
  );
  const targetOptions = [
    { value: NEW_RUN, label: "A new run" },
    ...openRuns.map((run) => ({
      value: String(run.id),
      label: runOptionLabel(run),
    })),
  ];

  async function importIntoExisting(sheet: File) {
    const runId = Number(target);
    try {
      const result = await importList.mutateAsync({ file: sheet, runId });
      if (!result.ok) {
        setError(result.error);
      } else if ("added" in result) {
        setImported({ added: result.added, runId });
      }
    } catch (failure) {
      setError(messageOf(failure));
    }
  }

  async function importIntoNew(sheet: File) {
    let urls = sheetUrls;
    if (!urls) {
      try {
        const result = await importList.mutateAsync({ file: sheet });
        if (!result.ok) {
          setError(result.error);
          return;
        }
        if (!("urls" in result)) {
          setError("The server did not return any URLs.");
          return;
        }
        urls = result.urls;
      } catch (failure) {
        setError(messageOf(failure));
        return;
      }
      if (urls.length === 0) {
        setError("No URLs were found in that sheet.");
        return;
      }
      setSheetUrls(urls);
    }

    let run = createdRun;
    if (!run) {
      try {
        run = await createRun.mutateAsync({
          projectId: Number(projectId),
          label: label.trim(),
        });
      } catch (failure) {
        setError(messageOf(failure));
        return;
      }
      setCreatedRun(run);
    }

    try {
      const result = await enqueue.mutateAsync({ runId: run.id, urls });
      if (!result.ok) {
        setError(
          `Run #${run.id} was created, but the URLs were not added: ${result.error}`,
        );
        return;
      }
      setImported({ added: result.added, runId: run.id });
    } catch (failure) {
      setError(
        `Run #${run.id} was created, but the URLs were not added: ${messageOf(failure)}`,
      );
    }
  }

  async function submit() {
    setError(null);
    if (!file) {
      setError("Choose a spreadsheet file to upload.");
      return;
    }
    if (isNew && !createdRun && projectId === "") {
      setError("Choose a project for the new run.");
      return;
    }
    await (isNew ? importIntoNew(file) : importIntoExisting(file));
  }

  const locked = createdRun !== null;

  return (
    <Modal
      title="Import list"
      onClose={onClose}
      actions={
        imported ? (
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        ) : (
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button
              variant="primary"
              onClick={() => void submit()}
              disabled={busy}
            >
              {busy ? "Importing…" : "Import"}
            </Button>
          </>
        )
      }
    >
      {imported ? (
        <Text variant="body" role="status" className={styles.status}>
          Added {imported.added} {imported.added === 1 ? "URL" : "URLs"} to run #
          {imported.runId}.
        </Text>
      ) : (
        <>
          <Field htmlFor={`${ids}-file`} label="Spreadsheet file">
            <input
              id={`${ids}-file`}
              type="file"
              accept=".csv,.tsv,.txt,.xlsx,.xls"
              className={styles.fileInput}
              disabled={locked}
              onChange={(event) => {
                setFile(event.target.files?.[0] ?? null);
                // A different sheet invalidates the URLs read from the last one.
                if (!createdRun) {
                  setSheetUrls(null);
                }
              }}
            />
          </Field>
          <Text variant="small" tone="secondary" className={styles.hint}>
            Upload a csv, tsv, txt, xlsx or xls file with a column of URLs.
          </Text>
          <Field htmlFor={`${ids}-target`} label="Add to">
            <Select
              id={`${ids}-target`}
              value={target}
              options={targetOptions}
              onChange={setTarget}
              disabled={locked}
            />
          </Field>
          {isNew ? (
            <>
              <Field htmlFor={`${ids}-project`} label="Project">
                <Select
                  id={`${ids}-project`}
                  value={projectId}
                  options={projectOptions(projectsQuery)}
                  onChange={setProjectId}
                  disabled={locked}
                />
              </Field>
              {projectsQuery.isError ? (
                <Text
                  variant="small"
                  tone="negative"
                  role="alert"
                  className={styles.error}
                >
                  Couldn't load projects: {projectsQuery.error.message}
                </Text>
              ) : null}
              <Field htmlFor={`${ids}-label`} label="Label (optional)">
                <TextInput
                  id={`${ids}-label`}
                  value={label}
                  onChange={setLabel}
                  placeholder="e.g. Imported list"
                />
              </Field>
            </>
          ) : null}
          {error ? (
            <Text
              variant="small"
              tone="negative"
              role="alert"
              className={styles.error}
            >
              {error}
            </Text>
          ) : null}
        </>
      )}
    </Modal>
  );
}
