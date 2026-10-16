import { useNavigate } from "react-router";
import { Button } from "@/components/atoms/Button";
import { Text } from "@/components/atoms/Text";
import { useCreateProject } from "@/features/projects";
import { dashboardClient } from "@/lib/api-client";
import type { ApiClient } from "@/lib/http/api-client";
import type { Recipe } from "@/lib/schemas";
import styles from "./Builder.module.scss";

type SaveProjectBarProps = {
  /** The assembled recipe, or null while it can't be saved yet. */
  recipe: Recipe | null;
  /** Why Save is unavailable (shown while `recipe` is null). */
  blockedReason?: string;
  /** Moves the operator to the URL field to test the rule on another page. */
  onRetest: () => void;
  /** Injectable for tests; production uses the shared dashboard client. */
  client?: ApiClient;
};

export function SaveProjectBar({
  recipe,
  blockedReason,
  onRetest,
  client = dashboardClient,
}: SaveProjectBarProps) {
  const navigate = useNavigate();
  const createProject = useCreateProject(client);

  function save() {
    if (!recipe) {
      return;
    }
    createProject.mutate(
      { name: recipe.name, recipe },
      { onSuccess: () => navigate("/projects") },
    );
  }

  return (
    <div className={styles.saveBar}>
      <div className={styles.saveActions}>
        <Button
          variant="primary"
          onClick={save}
          disabled={!recipe || createProject.isPending}
        >
          {createProject.isPending ? "Saving…" : "Save project"}
        </Button>
        <Button onClick={onRetest}>Re-test on another URL</Button>
      </div>
      {!recipe && blockedReason ? (
        <Text variant="small" tone="secondary">
          {blockedReason}
        </Text>
      ) : null}
      {createProject.isError ? (
        <Text variant="small" tone="negative" role="alert">
          Couldn't save the project: {createProject.error.message}
        </Text>
      ) : null}
    </div>
  );
}
