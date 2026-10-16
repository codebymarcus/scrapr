import { useId, useState } from "react";
import { Button } from "@/components/atoms/Button";
import { Text } from "@/components/atoms/Text";
import { dashboardClient } from "@/lib/api-client";
import type { ApiClient } from "@/lib/http/api-client";
import type { Project } from "@/lib/schemas";
import { useDeleteProject } from "../hooks/use-project-mutations";
import styles from "./ProjectCard.module.scss";

type ProjectCardProps = {
  project: Project;
  /** Starts a run from this project (the page owns the navigation). */
  onNewRun: (projectId: number) => void;
  /** Injectable for tests; production uses the shared dashboard client. */
  client?: ApiClient;
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}

export function ProjectCard({
  project,
  onNewRun,
  client = dashboardClient,
}: ProjectCardProps) {
  const headingId = useId();
  const deleteProject = useDeleteProject(client);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hosts = project.recipe.match?.hosts ?? [];

  async function confirmDelete() {
    setError(null);
    try {
      const result = await deleteProject.mutateAsync(project.id);
      if (!result.ok) {
        // 409: the project still has runs. Keep it, say why.
        setError(result.error);
        setConfirming(false);
      }
    } catch (failure) {
      setError(messageOf(failure));
      setConfirming(false);
    }
  }

  return (
    <article className={styles.card} aria-labelledby={headingId}>
      <div className={styles.top}>
        <Text
          id={headingId}
          variant="body"
          as="h3"
          weight="semibold"
          className={styles.name}
        >
          {project.name}
        </Text>
        <span className={styles.tag}>{project.recipe.contentType}</span>
      </div>

      <Text variant="small" tone="secondary" className={styles.hosts}>
        {hosts.length > 0 ? hosts.join(", ") : "Any host"}
      </Text>

      <div className={styles.actions}>
        <Button
          variant="primary"
          aria-describedby={headingId}
          onClick={() => onNewRun(project.id)}
        >
          New run from this
        </Button>
        {confirming ? (
          <>
            <Button
              disabled={deleteProject.isPending}
              aria-label={`Confirm delete ${project.name}`}
              onClick={() => void confirmDelete()}
            >
              {deleteProject.isPending ? "Deleting…" : "Confirm delete"}
            </Button>
            <Button
              disabled={deleteProject.isPending}
              onClick={() => setConfirming(false)}
            >
              Cancel
            </Button>
          </>
        ) : (
          <Button
            aria-label={`Delete ${project.name}`}
            onClick={() => {
              setError(null);
              setConfirming(true);
            }}
          >
            Delete
          </Button>
        )}
      </div>

      {error ? (
        <Text variant="small" tone="negative" role="alert">
          {error}
        </Text>
      ) : null}
    </article>
  );
}
