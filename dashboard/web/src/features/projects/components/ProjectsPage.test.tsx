import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { describe, expect, it } from "vitest";
import { createApiClient } from "@/lib/http/api-client";
import { makeProject } from "@/test/fixtures";
import { ProjectsPage } from "./ProjectsPage";

type Call = { path: string; method: string };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const projects = [
  makeProject({
    id: 1,
    name: "Manga reader",
    recipe: {
      name: "manga",
      contentType: "image",
      match: { hosts: ["manga.test", "reader.test"] },
    },
  }),
  makeProject({
    id: 2,
    name: "News articles",
    recipe: { name: "news", contentType: "text" },
  }),
];

function LocationProbe() {
  const location = useLocation();
  return (
    <p data-testid="location">
      {location.pathname}
      {location.state ? JSON.stringify(location.state) : ""}
    </p>
  );
}

function setup(
  options: {
    list?: () => Response;
    onDelete?: (id: string) => Response;
  } = {},
) {
  const calls: Call[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    const method = init?.method ?? "GET";
    calls.push({ path, method });
    if (method === "GET" && path === "/api/projects") {
      return options.list ? options.list() : json({ projects });
    }
    const match = /^\/api\/projects\/(\d+)$/.exec(path);
    if (method === "DELETE" && match) {
      return options.onDelete
        ? options.onDelete(match[1])
        : new Response(null, { status: 204 });
    }
    return json({ error: "not found" }, 404);
  };
  const client = createApiClient({ baseUrl: "http://test.local", fetchFn });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/projects"]}>
        <Routes>
          <Route path="/projects" element={<ProjectsPage client={client} />} />
          <Route path="*" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { calls };
}

describe("ProjectsPage", () => {
  it("lists projects with content type and target hosts", async () => {
    setup();

    const manga = await screen.findByRole("article", { name: "Manga reader" });
    expect(within(manga).getByText("image")).toBeInTheDocument();
    expect(within(manga).getByText("manga.test, reader.test")).toBeInTheDocument();

    const news = screen.getByRole("article", { name: "News articles" });
    expect(within(news).getByText("text")).toBeInTheDocument();
    expect(within(news).getByText("Any host")).toBeInTheDocument();
  });

  it("shows an empty state when there are no projects", async () => {
    setup({ list: () => json({ projects: [] }) });

    expect(await screen.findByText("No projects yet")).toBeInTheDocument();
  });

  it("shows an error state when the list fails", async () => {
    setup({ list: () => json({ error: "boom" }, 400) });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn't load projects.",
    );
  });

  it("navigates to the builder from 'New project'", async () => {
    setup();

    await userEvent.click(
      await screen.findByRole("button", { name: "New project" }),
    );

    expect(await screen.findByTestId("location")).toHaveTextContent(
      "/projects/new",
    );
  });

  it("starts a new run from a project", async () => {
    setup();

    const manga = await screen.findByRole("article", { name: "Manga reader" });
    await userEvent.click(
      within(manga).getByRole("button", { name: "New run from this" }),
    );

    expect(await screen.findByTestId("location")).toHaveTextContent(
      '/{"newRunProjectId":1}',
    );
  });

  it("deletes a project after confirmation", async () => {
    const { calls } = setup();

    const news = await screen.findByRole("article", { name: "News articles" });
    await userEvent.click(
      within(news).getByRole("button", { name: "Delete News articles" }),
    );
    await userEvent.click(
      within(news).getByRole("button", { name: "Confirm delete News articles" }),
    );

    expect(
      calls.some((c) => c.method === "DELETE" && c.path === "/api/projects/2"),
    ).toBe(true);
  });

  it("shows the server's message when a project with runs can't be deleted", async () => {
    const message =
      "Project has runs and cannot be deleted. Delete its runs first.";
    setup({ onDelete: () => json({ error: message }, 409) });

    const manga = await screen.findByRole("article", { name: "Manga reader" });
    await userEvent.click(
      within(manga).getByRole("button", { name: "Delete Manga reader" }),
    );
    await userEvent.click(
      within(manga).getByRole("button", {
        name: "Confirm delete Manga reader",
      }),
    );

    expect(await within(manga).findByRole("alert")).toHaveTextContent(message);
    // The project is still listed.
    expect(manga).toBeInTheDocument();
  });

  it("lets the user back out of a delete", async () => {
    const { calls } = setup();

    const news = await screen.findByRole("article", { name: "News articles" });
    await userEvent.click(
      within(news).getByRole("button", { name: "Delete News articles" }),
    );
    await userEvent.click(within(news).getByRole("button", { name: "Cancel" }));

    expect(
      within(news).getByRole("button", { name: "Delete News articles" }),
    ).toBeInTheDocument();
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });
});
