import { useNavigate } from "react-router";
import { Button } from "@/components/atoms/Button";
import { Text } from "@/components/atoms/Text";
import { ErrorState } from "@/components/molecules/ErrorState";
import { PageLayout } from "@/components/templates/PageLayout";
import { dashboardClient } from "@/lib/api-client";
import type { ApiClient } from "@/lib/http/api-client";
import { useProjects } from "../hooks/use-projects";
import type { NewRunFromProjectState } from "../types";
import { ProjectCard } from "./ProjectCard";
import styles from "./ProjectsPage.module.scss";

type ProjectsPageProps = {
  /** Injectable for tests; production uses the shared dashboard client. */
  client?: ApiClient;
};

export function ProjectsPage({ client = dashboardClient }: ProjectsPageProps) {
  const navigate = useNavigate();
  const projectsQuery = useProjects(client);

  const headerActions = (
    <Button variant="primary" onClick={() => navigate("/projects/new")}>
      New project
    </Button>
  );

  function startRunFrom(projectId: number) {
    const state: NewRunFromProjectState = { newRunProjectId: projectId };
    navigate("/", { state });
  }

  function renderBody() {
    if (projectsQuery.isPending) {
      return (
        <div className={styles.skeleton} aria-busy="true">
          <Text variant="body" tone="secondary" role="status">
            Loading projects…
          </Text>
        </div>
      );
    }

    if (projectsQuery.isError) {
      return (
        <ErrorState
          title="Couldn't load projects."
          message={projectsQuery.error.message}
          onRetry={() => void projectsQuery.refetch()}
          isRetrying={projectsQuery.isFetching}
        />
      );
    }

    if (projectsQuery.data.length === 0) {
      return (
        <section className={styles.empty}>
          <Text variant="heading" as="h2">
            No projects yet
          </Text>
          <Text variant="body" tone="secondary">
            A project is a saved scraping recipe. Create one to start runs.
          </Text>
        </section>
      );
    }

    return (
      <ul className={styles.grid}>
        {projectsQuery.data.map((project) => (
          <li key={project.id} className={styles.item}>
            <ProjectCard
              project={project}
              onNewRun={startRunFrom}
              client={client}
            />
          </li>
        ))}
      </ul>
    );
  }

  return (
    <PageLayout
      title="Projects"
      subtitle="Saved recipes that runs are started from."
      actions={headerActions}
    >
      {renderBody()}
    </PageLayout>
  );
}
