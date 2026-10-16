import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it } from "vitest";
import { createApiClient } from "@/lib/http/api-client";
import { usePreferencesStore } from "@/stores/use-preferences-store";
import { SettingsPage } from "./SettingsPage";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const connected = {
  connected: true,
  credentialsPath: "/repo/credentials.json",
  tokenPath: "/repo/token.json",
  hint: "Google Drive is connected.",
};

const disconnected = {
  connected: false,
  credentialsPath: "/repo/credentials.json",
  tokenPath: "/repo/token.json",
  hint: "Drive is not connected. Run `node authorize.mjs` from the repo root to authorize.",
};

function setup(respond: () => Response) {
  const client = createApiClient({
    baseUrl: "http://test.local",
    fetchFn: async () => respond(),
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <SettingsPage client={client} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  usePreferencesStore.setState({ theme: "dark", grain: true });
});

describe("SettingsPage", () => {
  it("shows Connected with the credential and token paths", async () => {
    setup(() => json(connected));

    expect(await screen.findByText("Connected")).toBeInTheDocument();
    expect(screen.getByText("/repo/credentials.json")).toBeInTheDocument();
    expect(screen.getByText("/repo/token.json")).toBeInTheDocument();
  });

  it("shows the authorize.mjs hint when Drive is not connected", async () => {
    setup(() => json(disconnected));

    expect(await screen.findByText("Not connected")).toBeInTheDocument();
    expect(screen.getByText(/node authorize\.mjs/)).toBeInTheDocument();
    expect(screen.getByText("/repo/token.json")).toBeInTheDocument();
  });

  it("shows an error state with retry when the status fails", async () => {
    setup(() => json({ error: "boom" }, 400));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn't load Drive status.",
    );
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    // Appearance still works without Drive.
    expect(screen.getByRole("switch", { name: "Film grain" })).toBeInTheDocument();
  });

  it("flips the grain preference and the data-grain attribute", async () => {
    setup(() => json(connected));

    const grain = await screen.findByRole("switch", { name: "Film grain" });
    expect(grain).toBeChecked();

    await userEvent.click(grain);

    expect(usePreferencesStore.getState().grain).toBe(false);
    expect(grain).not.toBeChecked();
    expect(document.documentElement).not.toHaveAttribute("data-grain");

    await userEvent.click(grain);

    expect(usePreferencesStore.getState().grain).toBe(true);
    expect(document.documentElement).toHaveAttribute("data-grain");
  });

  it("flips the theme preference", async () => {
    setup(() => json(connected));

    const theme = await screen.findByRole("switch", { name: "Dark theme" });
    expect(theme).toBeChecked();

    await userEvent.click(theme);

    expect(usePreferencesStore.getState().theme).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
  });
});
