import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it } from "vitest";
import { createApiClient } from "@/lib/http/api-client";
import { makeProject } from "@/test/fixtures";
import { CANDIDATES, thumbSrc } from "../test/fixtures";
import { BuilderPage } from "./BuilderPage";

const BASE = "http://test.local";
const PAGE_URL = "https://reader.test/manga/ch-1";

type Call = { path: string; method: string; body: unknown };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const okImages = {
  status: "ok",
  via: "browser",
  images: CANDIDATES,
  unenforcedRuleKeys: [] as string[],
};

function setup(
  options: {
    image?: () => Response;
    text?: () => Response;
    create?: () => Response;
    run?: () => Response;
  } = {},
) {
  const calls: Call[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    const method = init?.method ?? "GET";
    const body: unknown = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, method, body });
    if (path === "/api/preview/image") {
      return options.image ? options.image() : json(okImages);
    }
    if (path === "/api/preview/text") {
      return options.text ? options.text() : json({ status: "ok" });
    }
    if (path === "/api/projects" && method === "POST") {
      return options.create
        ? options.create()
        : json({ project: makeProject({ id: 7 }) }, 201);
    }
    if (path === "/api/runs" && method === "POST") {
      return options.run
        ? options.run()
        : json({ run: { id: 11, project_id: 7, state: "queued" } }, 201);
    }
    return json({ error: "not found" }, 404);
  };
  const client = createApiClient({ baseUrl: BASE, fetchFn });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/projects/new"]}>
        <Routes>
          <Route
            path="/projects/new"
            element={<BuilderPage client={client} apiBase={BASE} />}
          />
          <Route path="/projects" element={<p>Projects page</p>} />
          <Route path="/" element={<p>Runs page</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { calls };
}

async function pasteUrlAndFetch(url = PAGE_URL) {
  await userEvent.click(screen.getByLabelText("Page URL"));
  await userEvent.paste(url);
  await userEvent.click(screen.getByRole("button", { name: "Fetch & detect" }));
}

describe("BuilderPage", () => {
  it("renders candidate thumbnails proxied through /api/thumb", async () => {
    const { calls } = setup();

    await pasteUrlAndFetch();

    const first = await screen.findByRole("img", { name: "Candidate image 1" });
    // Thumbnails carry the previewed page URL as the Referer (hotlink defeat).
    expect(first).toHaveAttribute("src", thumbSrc(BASE, CANDIDATES[0].url, PAGE_URL));
    expect(screen.getByRole("img", { name: "Candidate image 4" })).toHaveAttribute(
      "src",
      thumbSrc(BASE, CANDIDATES[3].url, PAGE_URL),
    );
    const preview = calls.find((c) => c.path === "/api/preview/image");
    expect(preview?.body).toMatchObject({
      url: PAGE_URL,
      recipe: { contentType: "image" },
    });
  });

  it("shows why a preview failed instead of an empty grid", async () => {
    setup({
      image: () =>
        json({
          status: "fail",
          code: "HTTP_ERROR",
          message: "The page answered 403.",
          images: [],
        }),
    });

    await pasteUrlAndFetch();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The page answered 403.");
    expect(alert).toHaveTextContent("HTTP_ERROR");
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("shows the server error when the preview request itself fails", async () => {
    setup({ image: () => json({ error: "browser unavailable: no chrome" }, 503) });

    await pasteUrlAndFetch();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "browser unavailable: no chrome",
    );
  });

  it("rejects a URL that is not http(s) without calling the server", async () => {
    const { calls } = setup();

    await pasteUrlAndFetch("not a url");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Enter a full http(s) URL",
    );
    expect(calls).toHaveLength(0);
  });

  it("derives the saved rule from keep/drop and saves it, not the image urls", async () => {
    const { calls } = setup();
    await pasteUrlAndFetch();
    await screen.findByRole("img", { name: "Candidate image 1" });

    await userEvent.click(screen.getByRole("checkbox", { name: "Keep image 3" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Keep image 4" }));

    // Smallest kept image is 800x1200; the dropped ones are smaller.
    expect(screen.getByLabelText("Min width (px)")).toHaveValue("800");
    expect(screen.getByLabelText("Min height (px)")).toHaveValue("1200");
    expect(screen.getByRole("status", { name: "Rule result" })).toHaveTextContent(
      "Rule keeps 2 of 4 images",
    );

    await userEvent.type(screen.getByLabelText("Project name"), "Manga reader");
    await userEvent.click(screen.getByRole("button", { name: "Save project" }));

    expect(await screen.findByText("Projects page")).toBeInTheDocument();
    const save = calls.find((c) => c.path === "/api/projects");
    expect(save?.body).toEqual({
      name: "Manga reader",
      recipe: {
        name: "Manga reader",
        contentType: "image",
        image: { rules: { minWidth: 800, minHeight: 1200 }, pipeline: [] },
        output: { cbz: true },
      },
    });
    // No specific test-page image url leaks into the saved recipe.
    const saved = JSON.stringify(save?.body);
    for (const candidate of CANDIDATES) {
      expect(saved).not.toContain(candidate.url);
    }
  });

  it("explains when no size threshold separates the dropped images", async () => {
    setup({
      image: () =>
        json({
          ...okImages,
          images: [
            { url: "https://cdn.test/a.jpg", width: 200, height: 900 },
            { url: "https://cdn.test/b.jpg", width: 900, height: 200 },
            { url: "https://cdn.test/c.jpg", width: 300, height: 300 },
          ],
        }),
    });
    await pasteUrlAndFetch();
    await screen.findByRole("img", { name: "Candidate image 1" });

    await userEvent.click(screen.getByRole("checkbox", { name: "Keep image 3" }));

    expect(
      screen.getByText(/No size threshold separates/),
    ).toBeInTheDocument();
  });

  it("warns about preview-only rules the run will not apply", async () => {
    setup({ image: () => json({ ...okImages, unenforcedRuleKeys: ["excludeSelector"] }) });

    await pasteUrlAndFetch();

    expect(
      await screen.findByText(
        "These rules preview only, not applied at run: excludeSelector",
      ),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Exclude selector (preview-only)")).toBeDisabled();
  });

  it("requires a project name before saving", async () => {
    setup();
    await pasteUrlAndFetch();
    await screen.findByRole("img", { name: "Candidate image 1" });

    expect(screen.getByRole("button", { name: "Save project" })).toBeDisabled();
    expect(screen.getByText("Name the project to save it.")).toBeInTheDocument();
  });

  it("shows the server's message when saving fails", async () => {
    setup({ create: () => json({ error: "Project name already exists" }, 409) });
    await pasteUrlAndFetch();
    await screen.findByRole("img", { name: "Candidate image 1" });
    await userEvent.type(screen.getByLabelText("Project name"), "Dup");

    await userEvent.click(screen.getByRole("button", { name: "Save project" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Project name already exists",
    );
    expect(screen.queryByText("Projects page")).toBeNull();
  });

  it("disables the scopes that have no preview yet", () => {
    setup();

    expect(screen.getByRole("radio", { name: "Images" })).toBeChecked();
    expect(screen.getByRole("radio", { name: /Links/ })).toBeDisabled();
    expect(screen.getByRole("radio", { name: /Tables/ })).toBeDisabled();
  });

  it("re-tests the saved rule on another URL", async () => {
    const { calls } = setup();
    await pasteUrlAndFetch();
    await screen.findByRole("img", { name: "Candidate image 1" });
    await userEvent.type(screen.getByLabelText("Min width (px)"), "500");

    await userEvent.click(
      screen.getByRole("button", { name: "Re-test on another URL" }),
    );
    expect(screen.getByLabelText("Page URL")).toHaveFocus();
    await userEvent.paste("https://reader.test/manga/ch-2");
    await userEvent.click(screen.getByRole("button", { name: "Fetch & detect" }));

    await screen.findByRole("status", { name: "Rule result" });
    const previews = calls.filter((c) => c.path === "/api/preview/image");
    expect(previews).toHaveLength(2);
    expect(previews[1].body).toMatchObject({
      url: "https://reader.test/manga/ch-2",
      recipe: { image: { rules: { minWidth: 500 } } },
    });
    expect(screen.getByRole("status", { name: "Rule result" })).toHaveTextContent(
      "Rule keeps 2 of 4 images",
    );
  });

  describe("built-in recipe", () => {
    const CREATE = "Create a run with the built-in recipe";

    it("shows the notice naming the recipe when the preview matched one", async () => {
      setup({ image: () => json({ ...okImages, builtInRecipe: "batcave" }) });

      await pasteUrlAndFetch();

      const message = await screen.findByText(
        "This site has a built-in recipe (batcave). You can run it directly.",
      );
      expect(message.closest("[role='note']")).not.toBeNull();
      expect(screen.getByRole("button", { name: CREATE })).toBeEnabled();
      // The generic grid stays available as the secondary path.
      expect(
        await screen.findByRole("img", { name: "Candidate image 1" }),
      ).toBeInTheDocument();
    });

    it("shows no notice when no built-in recipe matched", async () => {
      setup({ image: () => json({ ...okImages, builtInRecipe: null }) });

      await pasteUrlAndFetch();
      await screen.findByRole("img", { name: "Candidate image 1" });

      expect(screen.queryByText(/built-in recipe/)).toBeNull();
      expect(screen.queryByRole("button", { name: CREATE })).toBeNull();
    });

    it("shows the notice for a text preview too", async () => {
      setup({
        text: () => json({ status: "ok", mode: "article", builtInRecipe: "batcave" }),
      });
      await userEvent.click(screen.getByRole("radio", { name: "Text" }));

      await pasteUrlAndFetch("https://batcave.test/read/1");

      expect(await screen.findByRole("button", { name: CREATE })).toBeInTheDocument();
    });

    it("creates a built-in project, then a run bound to it, then opens Runs", async () => {
      const { calls } = setup({
        image: () => json({ ...okImages, builtInRecipe: "batcave" }),
      });
      await pasteUrlAndFetch();

      await userEvent.click(await screen.findByRole("button", { name: CREATE }));

      expect(await screen.findByText("Runs page")).toBeInTheDocument();
      const writes = calls.filter((c) => c.method === "POST" && c.path !== "/api/preview/image");
      expect(writes.map((c) => c.path)).toEqual(["/api/projects", "/api/runs"]);
      expect(writes[0].body).toEqual({
        name: "batcave (built-in)",
        recipe: {
          name: "batcave",
          contentType: "image",
          builtIn: true,
          builtInProfile: "batcave",
        },
      });
      expect(writes[1].body).toEqual({ projectId: 7 });
    });

    it("uses the typed project name when there is one", async () => {
      const { calls } = setup({
        image: () => json({ ...okImages, builtInRecipe: "batcave" }),
      });
      await userEvent.type(screen.getByLabelText("Project name"), "My comic");
      await pasteUrlAndFetch();

      await userEvent.click(await screen.findByRole("button", { name: CREATE }));

      await screen.findByText("Runs page");
      expect(calls.find((c) => c.path === "/api/projects")?.body).toMatchObject({
        name: "My comic",
        recipe: { builtIn: true, builtInProfile: "batcave" },
      });
    });

    it("shows the error inline and stays put when creating fails", async () => {
      const { calls } = setup({
        image: () => json({ ...okImages, builtInRecipe: "batcave" }),
        create: () => json({ error: "Project name already exists" }, 409),
      });
      await pasteUrlAndFetch();

      await userEvent.click(await screen.findByRole("button", { name: CREATE }));

      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent("Project name already exists");
      expect(screen.queryByText("Runs page")).toBeNull();
      expect(calls.some((c) => c.path === "/api/runs")).toBe(false);
    });
  });

  describe("text scope", () => {
    const articleFields = {
      title: "A headline",
      byline: "By Someone",
      excerpt: "",
      markdown: "# Body text",
    };

    async function detectText() {
      await userEvent.click(screen.getByRole("radio", { name: "Text" }));
      await pasteUrlAndFetch("https://news.test/story");
    }

    it("lists detected fields with their values and saves the chosen ones", async () => {
      const { calls } = setup({
        text: () =>
          json({ status: "ok", via: "http", mode: "article", fields: articleFields }),
      });

      await detectText();

      const list = await screen.findByRole("list", { name: "Detected text fields" });
      expect(within(list).getByText("A headline")).toBeInTheDocument();
      expect(within(list).getByText("# Body text")).toBeInTheDocument();
      expect(screen.getByRole("note")).toHaveTextContent(
        "Article mode captures the whole article. Field selection is recorded for reference but does not change what the run extracts yet.",
      );
      expect(calls.find((c) => c.path === "/api/preview/text")?.body).toMatchObject({
        url: "https://news.test/story",
        recipe: { contentType: "text", text: { mode: "article" } },
      });
      expect(screen.queryByRole("img")).toBeNull();

      await userEvent.click(screen.getByRole("checkbox", { name: "Include byline" }));
      await userEvent.type(screen.getByLabelText("Project name"), "News");
      await userEvent.click(screen.getByRole("button", { name: "Save project" }));

      await screen.findByText("Projects page");
      expect(calls.find((c) => c.path === "/api/projects")?.body).toEqual({
        name: "News",
        recipe: {
          name: "News",
          contentType: "text",
          text: { mode: "article" },
          metadata: { textFields: ["title", "markdown"] },
        },
      });
    });

    it("shows selector-mode fields given as name/value pairs", async () => {
      setup({
        text: () =>
          json({
            status: "ok",
            mode: "selector",
            fields: [{ name: "tags", value: ["a", "b"] }],
          }),
      });

      await detectText();

      expect(await screen.findByRole("checkbox", { name: "Include tags" })).toBeChecked();
    });

    it("shows why a text preview failed", async () => {
      setup({ text: () => json({ status: "fail", code: "NETWORK_ERROR" }) });

      await detectText();

      expect(await screen.findByRole("alert")).toHaveTextContent("NETWORK_ERROR");
    });

    it("says so when nothing was detected", async () => {
      setup({ text: () => json({ status: "ok", mode: "article", fields: {} }) });

      await detectText();

      expect(await screen.findByText("No text fields detected on this page.")).toBeInTheDocument();
    });
  });
});
