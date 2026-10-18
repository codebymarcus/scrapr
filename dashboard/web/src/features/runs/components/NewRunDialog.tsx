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
import type { Recipe, Run } from "@/lib/schemas";
import type { RunFormat, RunOverrides } from "../api/runs-api";
import { useCreateRun, useEnqueue, useImport } from "../hooks/use-run-mutations";
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

// The recipe's packaging flags collapse to a single picker value.
function recipeFormat(recipe: Recipe | undefined): RunFormat {
  const cbz = recipe?.output?.cbz;
  const pdf = recipe?.output?.pdf;
  if (cbz && pdf) return "both";
  if (pdf) return "pdf";
  if (cbz) return "cbz";
  return "loose";
}

const FORMAT_LABELS: Record<RunFormat, string> = {
  cbz: "CBZ",
  pdf: "PDF",
  both: "Both (CBZ + PDF)",
  loose: "Loose images only",
};

export function NewRunDialog({
  onClose,
  initialProjectId,
  client = dashboardClient,
}: NewRunDialogProps) {
  const ids = useId();
  const projectsQuery = useProjects(client);
  const createRun = useCreateRun(client);
  const enqueue = useEnqueue(client);
  const importSheet = useImport(client);

  const [projectId, setProjectId] = useState(
    initialProjectId === undefined ? "" : String(initialProjectId),
  );
  const [label, setLabel] = useState("");
  const [urlText, setUrlText] = useState("");
  // A chosen sheet takes precedence over pasted URLs (never both).
  const [file, setFile] = useState<File | null>(null);
  // Drive edits the user has made for the selected project; `null` means
  // "untouched", so the value falls back to the project's recipe default.
  const [driveEdit, setDriveEdit] = useState<boolean | null>(null);
  const [folderEdit, setFolderEdit] = useState<string | null>(null);
  const [subfolderEdit, setSubfolderEdit] = useState<string | null>(null);
  const [formatEdit, setFormatEdit] = useState<RunFormat | null>(null);
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
  // Loose images can't be uploaded, so when Drive is on, coerce/limit to a
  // packaged format (the upload would otherwise silently find nothing to send).
  const chosenFormat = formatEdit ?? recipeFormat(recipe);
  const format: RunFormat = drive && chosenFormat === "loose" ? "cbz" : chosenFormat;
  const formatOptions = (drive
    ? (["cbz", "pdf", "both"] as const)
    : (["cbz", "pdf", "both", "loose"] as const)
  ).map((value) => ({ value, label: FORMAT_LABELS[value] }));

  function chooseProject(value: string) {
    setProjectId(value);
    setDriveEdit(null);
    setFolderEdit(null);
    setSubfolderEdit(null);
    setFormatEdit(null);
  }

  // The server applies only the keys that are present, so a blank folder must
  // be omitted rather than sent as "" (which would erase the recipe's folder).
  function buildOverrides(): RunOverrides | undefined {
    if (!showDrive) return undefined;
    const overrides: RunOverrides = { drive, format };
    if (folder.trim()) overrides.driveFolder = folder.trim();
    if (subfolder.trim()) overrides.driveSubfolder = subfolder.trim();
    return overrides;
  }

  const busy =
    createRun.isPending || enqueue.isPending || importSheet.isPending;

  async function submit() {
    setError(null);
    if (!createdRun && projectId === "") {
      setError("Choose a project for this run.");
      return;
    }
    // The sheet wins, so pasted text is not validated when a file is chosen.
    const { urls, invalid } = file
      ? { urls: [], invalid: [] }
      : parseUrlList(urlText);
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

    if (file) {
      try {
        const result = await importSheet.mutateAsync({ file, runId: run.id });
        if (!result.ok) {
          setError(
            `Run #${run.id} was created, but the sheet was not imported: ${result.error}`,
          );
          return;
        }
      } catch (failure) {
        setError(
          `Run #${run.id} was created, but the sheet was not imported: ${messageOf(failure)}`,
        );
        return;
      }
    } else if (urls.length > 0) {
      // URLs are optional; the server rejects an empty list, so never send one.
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

  const submitLabel = createdRun
    ? file
      ? "Add items"
      : "Add URLs"
    : "Create run";

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
      <Field htmlFor={`${ids}-file`} label="Or upload a sheet">
        <input
          id={`${ids}-file`}
          type="file"
          accept=".csv,.tsv,.txt,.xlsx,.xls"
          className={styles.fileInput}
          onChange={(event) => setFile(event.target.files?.[0] ?? null)}
        />
      </Field>
      <Text variant="small" tone="secondary" className={styles.hint}>
        {file
          ? "The sheet will be imported; any pasted URLs are ignored."
          : "Upload a csv, tsv, txt, xlsx or xls file with a column of URLs."}
      </Text>
      {showDrive ? (
        <div className={styles.driveSection}>
          <Field htmlFor={`${ids}-format`} label="Output format">
            <Select
              id={`${ids}-format`}
              value={format}
              options={formatOptions}
              onChange={setFormatEdit}
              disabled={createdRun !== null}
            />
          </Field>
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
