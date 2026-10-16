import { useId, useState } from "react";
import { Button } from "@/components/atoms/Button";
import { Select } from "@/components/atoms/Select";
import { Text } from "@/components/atoms/Text";
import { TextArea } from "@/components/atoms/TextArea";
import { TextInput } from "@/components/atoms/TextInput";
import { Field } from "@/components/molecules/Field";
import { Modal } from "@/components/molecules/Modal";
import { dashboardClient } from "@/lib/api-client";
import type { ApiClient } from "@/lib/http/api-client";
import type { Run } from "@/lib/schemas";
import { useProjectsLite } from "../hooks/use-projects-lite";
import { useCreateRun, useEnqueue } from "../hooks/use-run-mutations";
import { describeInvalidLines, parseUrlList } from "../url-list";
import { projectOptions } from "./project-options";
import styles from "./RunDialogs.module.scss";

type NewRunDialogProps = {
  onClose: () => void;
  /** Injectable for tests; production uses the shared dashboard client. */
  client?: ApiClient;
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}

export function NewRunDialog({
  onClose,
  client = dashboardClient,
}: NewRunDialogProps) {
  const ids = useId();
  const projectsQuery = useProjectsLite(client);
  const createRun = useCreateRun(client);
  const enqueue = useEnqueue(client);

  const [projectId, setProjectId] = useState("");
  const [label, setLabel] = useState("");
  const [urlText, setUrlText] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Set once the run exists, so a failed enqueue can be retried without
  // creating a second run.
  const [createdRun, setCreatedRun] = useState<Run | null>(null);

  const busy = createRun.isPending || enqueue.isPending;

  async function submit() {
    setError(null);
    if (!createdRun && projectId === "") {
      setError("Choose a project for this run.");
      return;
    }
    const { urls, invalid } = parseUrlList(urlText);
    if (invalid.length > 0) {
      setError(describeInvalidLines(invalid));
      return;
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

    // URLs are optional; the server rejects an empty list, so never send one.
    if (urls.length > 0) {
      try {
        const result = await enqueue.mutateAsync({ runId: run.id, urls });
        if (!result.ok) {
          setError(
            `Run #${run.id} was created, but its URLs were not added: ${result.error}`,
          );
          return;
        }
      } catch (failure) {
        setError(
          `Run #${run.id} was created, but its URLs were not added: ${messageOf(failure)}`,
        );
        return;
      }
    }
    onClose();
  }

  const submitLabel = createdRun ? "Add URLs" : "Create run";

  return (
    <Modal
      title="New run"
      onClose={onClose}
      actions={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void submit()} disabled={busy}>
            {busy ? "Working…" : submitLabel}
          </Button>
        </>
      }
    >
      <Field htmlFor={`${ids}-project`} label="Project">
        <Select
          id={`${ids}-project`}
          value={projectId}
          options={projectOptions(projectsQuery)}
          onChange={setProjectId}
          disabled={createdRun !== null}
        />
      </Field>
      {projectsQuery.isError ? (
        <Text variant="small" tone="negative" role="alert" className={styles.error}>
          Couldn't load projects: {projectsQuery.error.message}
        </Text>
      ) : null}
      {projectsQuery.data?.length === 0 ? (
        <Text variant="small" tone="secondary" className={styles.hint}>
          There are no projects yet. Create one first, then start a run.
        </Text>
      ) : null}
      <Field htmlFor={`${ids}-label`} label="Label (optional)">
        <TextInput
          id={`${ids}-label`}
          value={label}
          onChange={setLabel}
          placeholder="e.g. Weekend batch"
        />
      </Field>
      <Field htmlFor={`${ids}-urls`} label="URLs (optional, one per line)">
        <TextArea
          id={`${ids}-urls`}
          value={urlText}
          onChange={setUrlText}
          placeholder={"https://example.com/chapter-1\nhttps://example.com/chapter-2"}
        />
      </Field>
      {error ? (
        <Text variant="small" tone="negative" role="alert" className={styles.error}>
          {error}
        </Text>
      ) : null}
    </Modal>
  );
}
