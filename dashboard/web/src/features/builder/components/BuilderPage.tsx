import { useId, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { Button } from "@/components/atoms/Button";
import { Text } from "@/components/atoms/Text";
import { TextInput } from "@/components/atoms/TextInput";
import { ErrorState } from "@/components/molecules/ErrorState";
import { Field } from "@/components/molecules/Field";
import { PageLayout } from "@/components/templates/PageLayout";
import { useCreateProject } from "@/features/projects";
import { useCreateRun, useEnqueue } from "@/features/runs";
import { API_BASE } from "@/lib/api-base";
import { dashboardClient } from "@/lib/api-client";
import type { ApiClient } from "@/lib/http/api-client";
import type { Recipe } from "@/lib/schemas";
import { usePreviewImage, usePreviewText } from "../hooks/use-preview";
import {
  buildImageRecipe,
  buildTextRecipe,
  PREVIEW_NAME,
} from "../recipe";
import {
  applySizeRule,
  deriveSizeRule,
  draftToRules,
  EMPTY_DRAFT,
  keepsCandidate,
} from "../rules";
import { normalizeTextFields } from "../text-fields";
import type { DetectScope, ImageCandidate, RuleDraft } from "../types";
import styles from "./Builder.module.scss";
import { DetectFilter } from "./DetectFilter";
import { BuiltInRecipeNotice } from "./BuiltInRecipeNotice";
import { ImageCandidateGrid } from "./ImageCandidateGrid";
import { ImageRuleForm } from "./ImageRuleForm";
import { SaveProjectBar } from "./SaveProjectBar";
import { TextFieldList } from "./TextFieldList";
import { UnenforcedWarning } from "./UnenforcedWarning";

type BuilderPageProps = {
  /** Injectable for tests; production uses the shared dashboard client. */
  client?: ApiClient;
  /** Origin the thumbnail proxy is served from. */
  apiBase?: string;
};

const NO_CANDIDATES: readonly ImageCandidate[] = [];

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function describeFailure(result: {
  code?: string;
  message?: string;
}): string {
  const reason = result.message ?? "The page could not be previewed.";
  return result.code ? `${reason} (${result.code})` : reason;
}

export function BuilderPage({
  client = dashboardClient,
  apiBase = API_BASE,
}: BuilderPageProps) {
  const ids = useId();
  const urlInputRef = useRef<HTMLDivElement>(null);
  const previewImage = usePreviewImage(client);
  const previewText = usePreviewText(client);
  const navigate = useNavigate();
  const createProject = useCreateProject(client);
  const createRun = useCreateRun(client);
  const enqueue = useEnqueue(client);
  // Progress of the current built-in attempt, kept so a retry after a partial
  // failure reuses what exists instead of re-creating (and 409-ing on) it.
  const createdProjectIdRef = useRef<number | null>(null);
  const createdRunIdRef = useRef<number | null>(null);
  const [creatingBuiltIn, setCreatingBuiltIn] = useState(false);
  const [builtInError, setBuiltInError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [urlError, setUrlError] = useState<string | null>(null);
  const [scope, setScope] = useState<DetectScope>("images");
  // Which kind of preview the results below belong to.
  const [detected, setDetected] = useState<"images" | "text" | null>(null);
  // The URL the current results were fetched from, used as the thumbnail Referer.
  const [previewedUrl, setPreviewedUrl] = useState("");

  function resetBuiltInAttempt() {
    createdProjectIdRef.current = null;
    createdRunIdRef.current = null;
    setBuiltInError(null);
  }

  const [draft, setDraft] = useState<RuleDraft>(EMPTY_DRAFT);
  // Keep/drop picks for the fetched candidates. A test-page affordance only:
  // they derive the rule and are never saved.
  const [kept, setKept] = useState<boolean[]>([]);
  const [excludedText, setExcludedText] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  const rules = draftToRules(draft);
  const imageResult = detected === "images" ? previewImage.data : undefined;
  const textResult = detected === "text" ? previewText.data : undefined;
  const candidates = imageResult?.images ?? NO_CANDIDATES;
  const textFields = normalizeTextFields(textResult?.fields);

  function fetchAndDetect() {
    const target = url.trim();
    if (!isHttpUrl(target)) {
      setUrlError("Enter a full http(s) URL, e.g. https://example.com/page.");
      return;
    }
    setUrlError(null);
    // Keep the created project/run refs: a same-URL re-fetch must not
    // re-create them. Only editing the URL (onChange) invalidates them.
    setBuiltInError(null);
    const previewName = name.trim() || PREVIEW_NAME;

    if (scope === "images") {
      setDetected("images");
      previewText.reset();
      previewImage.mutate(
        { url: target, recipe: buildImageRecipe(previewName, rules) },
        {
          // Start from what the current rule keeps, so re-testing a saved
          // rule on another page shows the rule's verdict, not "keep all".
          onSuccess: (data) => {
            setPreviewedUrl(target);
            setKept((data.images ?? []).map((c) => keepsCandidate(c, rules)));
          },
        },
      );
    } else if (scope === "text") {
      setDetected("text");
      previewImage.reset();
      previewText.mutate(
        { url: target, recipe: buildTextRecipe(previewName, []) },
        {
          onSuccess: () => {
            setPreviewedUrl(target);
            setExcludedText(new Set());
          },
        },
      );
    }
  }

  function toggleCandidate(index: number, keep: boolean) {
    const next = kept.map((value, i) => (i === index ? keep : value));
    setKept(next);
    setDraft((current) =>
      applySizeRule(current, deriveSizeRule(candidates, next)),
    );
  }

  function toggleTextField(fieldName: string, include: boolean) {
    setExcludedText((current) => {
      const next = new Set(current);
      if (include) {
        next.delete(fieldName);
      } else {
        next.add(fieldName);
      }
      return next;
    });
  }

  function focusUrl() {
    const input = urlInputRef.current?.querySelector("input");
    input?.focus();
    input?.select();
  }

  const trimmedName = name.trim();
  const hasDrops = kept.some((value) => !value);
  const derivedNothing =
    hasDrops &&
    Object.keys(deriveSizeRule(candidates, kept)).length === 0;

  let recipe: Recipe | null = null;
  let blockedReason: string | undefined;
  if (detected === null || (imageResult ?? textResult)?.status !== "ok") {
    blockedReason = "Fetch a page and detect content first.";
  } else if (trimmedName === "") {
    blockedReason = "Name the project to save it.";
  } else if (detected === "images") {
    recipe = buildImageRecipe(trimmedName, rules);
  } else {
    recipe = buildTextRecipe(
      trimmedName,
      textFields.map((f) => f.name).filter((f) => !excludedText.has(f)),
    );
  }

  const pending = previewImage.isPending || previewText.isPending;
  const activeMutation = detected === "text" ? previewText : previewImage;
  const activeResult = imageResult ?? textResult;
  const builtInRecipe =
    !pending && activeResult?.status === "ok"
      ? (activeResult.builtInRecipe ?? null)
      : null;

  async function createBuiltInRun(profileName: string) {
    setCreatingBuiltIn(true);
    setBuiltInError(null);
    try {
      if (createdProjectIdRef.current === null) {
        const project = await createProject.mutateAsync({
          name: trimmedName || `${profileName} (built-in)`,
          recipe: {
            name: profileName,
            contentType: "image",
            builtIn: true,
            builtInProfile: profileName,
          },
        });
        createdProjectIdRef.current = project.id;
      }
      if (createdRunIdRef.current === null) {
        const run = await createRun.mutateAsync({
          projectId: createdProjectIdRef.current,
        });
        createdRunIdRef.current = run.id;
      }
      const queued = await enqueue.mutateAsync({
        runId: createdRunIdRef.current,
        urls: [previewedUrl],
      });
      if (!queued.ok) {
        throw new Error(queued.error);
      }
      resetBuiltInAttempt();
      navigate("/");
    } catch (error) {
      setBuiltInError(
        error instanceof Error
          ? error.message
          : "Couldn't create the run with the built-in recipe.",
      );
      setCreatingBuiltIn(false);
    }
  }

  function renderResults() {
    if (detected === null) {
      return null;
    }
    if (pending) {
      return (
        <Text variant="body" tone="secondary" role="status" aria-busy="true">
          Fetching the page…
        </Text>
      );
    }
    if (activeMutation.isError) {
      return (
        <ErrorState
          title="Couldn't run the preview."
          message={activeMutation.error.message}
          onRetry={fetchAndDetect}
        />
      );
    }
    if (!activeResult) {
      return null;
    }
    if (activeResult.status !== "ok") {
      return (
        <ErrorState
          title="Preview failed."
          message={describeFailure(activeResult)}
          onRetry={fetchAndDetect}
        />
      );
    }

    if (detected === "text") {
      return (
        <section className={styles.panel}>
          <Text variant="heading" as="h2">
            Text fields
          </Text>
          <TextFieldList
            fields={textFields}
            excluded={excludedText}
            onToggle={toggleTextField}
          />
        </section>
      );
    }

    if (candidates.length === 0) {
      return (
        <Text variant="body" tone="secondary">
          No images detected on this page.
        </Text>
      );
    }
    return (
      <div className={styles.results}>
        <ImageRuleForm draft={draft} onChange={setDraft} />
        <UnenforcedWarning keys={imageResult?.unenforcedRuleKeys ?? []} />
        {derivedNothing ? (
          <Text variant="small" tone="secondary" role="note">
            No size threshold separates the dropped images from the kept
            ones. Use the URL filters instead.
          </Text>
        ) : null}
        <ImageCandidateGrid
          candidates={candidates}
          kept={kept}
          rules={rules}
          onToggle={toggleCandidate}
          pageUrl={previewedUrl}
          apiBase={apiBase}
        />
      </div>
    );
  }

  return (
    <PageLayout
      title="New project"
      subtitle="Paste a page, pick what to keep, and save the rule that finds it."
    >
      <div className={styles.page}>
        <section className={styles.panel}>
          <div className={styles.inputs}>
            <Field htmlFor={`${ids}-name`} label="Project name">
              <TextInput
                id={`${ids}-name`}
                value={name}
                onChange={setName}
                placeholder="e.g. Manga reader"
              />
            </Field>
            <div ref={urlInputRef}>
              <Field htmlFor={`${ids}-url`} label="Page URL">
                <TextInput
                  id={`${ids}-url`}
                  value={url}
                  onChange={(value) => {
                    setUrl(value);
                    resetBuiltInAttempt();
                  }}
                  placeholder="https://example.com/chapter-1"
                />
              </Field>
            </div>
          </div>
          {urlError ? (
            <Text variant="small" tone="negative" role="alert">
              {urlError}
            </Text>
          ) : null}
          <DetectFilter value={scope} onChange={setScope} />
          <div>
            <Button variant="primary" onClick={fetchAndDetect} disabled={pending}>
              {pending ? "Fetching…" : "Fetch & detect"}
            </Button>
          </div>
        </section>

        {builtInRecipe ? (
          <BuiltInRecipeNotice
            profileName={builtInRecipe}
            onCreateRun={() => void createBuiltInRun(builtInRecipe)}
            creating={creatingBuiltIn}
            error={builtInError}
          />
        ) : null}

        {renderResults()}

        <SaveProjectBar
          recipe={recipe}
          blockedReason={blockedReason}
          onRetest={focusUrl}
          client={client}
        />
      </div>
    </PageLayout>
  );
}
