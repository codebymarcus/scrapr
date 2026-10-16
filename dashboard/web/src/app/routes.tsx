import { Route, Routes } from "react-router";
import { AppLayout } from "@/app/AppLayout";
import { BuilderPage } from "@/features/builder";
import { ProjectsPage } from "@/features/projects";
import { RunsPage } from "@/features/runs";
import { SettingsPage } from "@/features/settings";

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route index element={<RunsPage />} />
        <Route path="projects" element={<ProjectsPage />} />
        <Route path="projects/new" element={<BuilderPage />} />
        <Route path="settings" element={<SettingsPage />} />
      </Route>
    </Routes>
  );
}
