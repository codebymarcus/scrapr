import { useId, useState } from "react";
import { Button } from "@/components/atoms/Button";
import { Select } from "@/components/atoms/Select";
import { Text } from "@/components/atoms/Text";
import { TextArea } from "@/components/atoms/TextArea";
import { TextInput } from "@/components/atoms/TextInput";
import { Field } from "@/components/molecules/Field";
import { Modal } from "@/components/molecules/Modal";
import { useProjects } from "@/features/projects";
import { dashboardClient } from "@/lib/api-client";
import type { ApiClient } from "@/lib/http/api-client";
import type { Run } from "@/lib/schemas";
import type { RunOverrides } from "../api/runs-api";
import { useCreateRun, useEnqueue } from "../hooks/use-run-mutations";
import { describeInvalidLines, parseUrlList } from "../url-list";
import { projectOptions } from "./project-options";
import styles from "./RunDialogs.module.scss";

type NewRunDialogProps = {
  onClose: () => void;
  /** Preselects a project, e.g. when started from the projects list. */
  initialProjectId?: number;
  /** Injectable for tests; production uses the shared dashboard client. */
  client?: ApiClient;
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}

export function NewRunDialog({
  onClose,
  initialProjectId,
  client = dashboardClient,
}: NewRunDialogProps) {
  const ids = useId();
  const projectsQuery = useProjects(client);
  const createRun = useCreateRun(client);
  const enqueue = useEnqueue(client);

  const [projectId, setProjectId] = useState(
    initialProjectId === undefined ? "" : String(initialProjectId),
  );
  const [label, setLabel] = useState("");
  const [urlText, setUrlText] = useState("");
  // Drive edits the user has made for the selected project; `null` means
  // "untouched", so the value falls back to the project's recipe default.
  const [driveEdit, setDriveEdit] = useState<boolean | null>(null);
  const [folderEdit, setFolderEdit] = useState<string | null>(null);
  const [subfolderEdit, setSubfolderEdit] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Set once the run exists, so a failed enqueue can be retried without
  // creating a second run.
  const [createdRun, setCreatedRun] = useState<Run | null>(null);

  const selectedProject = projectsQuery.data?.find(
    (project) => String(project.id) === projectId,
  );
  const recipe = selectedProject?.recipe;
  const showDrive = recipe?.contentType === "image";
  const drive = driveEdit ?? recipe?.output?.drive ?? false;
  const folder = folderEdit ?? recipe?.output?.driveFolder ?? "";
  const subfolder = subfolderEdit ?? recipe?.output?.driveSubfolder ?? "";

  function chooseProject(value: string) {
    setProjectId(value);
    setDriveEdit(null);
    setFolderEdit(null);
    setSubfolderEdit(null);
  }

  // The server applies only the keys that are present, so a blank folder must
  // be omitted rather than sent as "" (which would erase the recipe's folder).
  function buildOverrides(): RunOverrides | undefined {
    if (!showDrive) return undefined;
    const overrides: RunOverrides = { drive };
    if (folder.trim()) overrides.driveFolder = folder.trim();
    if (subfolder.trim()) overrides.driveSubfolder = subfolder.trim();
    return overrides;
  }

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
        const overrides = buildOverrides();
        run = await createRun.mutateAsync({
          projectId: Number(projectId),
          label: label.trim(),
          ...(overrides ? { overrides } : {}),
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
          onChange={chooseProject}
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
      {showDrive ? (
        <div className={styles.driveSection}>
          <label className={styles.toggle}>
            <input
              type="checkbox"
              role="switch"
              className={styles.switch}
              checked={drive}
              disabled={createdRun !== null}
              onChange={(event) => setDriveEdit(event.target.checked)}
            />
            <Text as="span" variant="body">
              Upload to Drive
            </Text>
          </label>
          <Field htmlFor={`${ids}-drive-folder`} label="Folder ID">
            <TextInput
              id={`${ids}-drive-folder`}
              value={folder}
              onChange={setFolderEdit}
              placeholder="Google Drive folder ID"
              disabled={createdRun !== null}
            />
          </Field>
          <Field htmlFor={`${ids}-drive-subfolder`} label="Subfolder name">
            <TextInput
              id={`${ids}-drive-subfolder`}
              value={subfolder}
              onChange={setSubfolderEdit}
              placeholder="Created inside the folder"
              disabled={createdRun !== null}
            />
          </Field>
        </div>
      ) : null}
      {error ? (
        <Text variant="small" tone="negative" role="alert" className={styles.error}>
          {error}
        </Text>
      ) : null}
    </Modal>
  );
}
