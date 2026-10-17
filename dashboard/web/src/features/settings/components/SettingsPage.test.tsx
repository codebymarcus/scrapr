import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  configured: true,
  reason: "ok",
  hint: "Google Drive is connected.",
};

const notConnected = {
  connected: false,
  configured: true,
  reason: "ok",
};

const notConfigured = {
  connected: false,
  configured: false,
  reason: "not-configured",
  hint: "Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET.",
};

const needsReconnect = {
  connected: false,
  configured: true,
  reason: "needs-reconnect",
  hint: "Drive authorization expired. Reconnect to continue.",
};

type Call = { method: string; path: string };

function setup(respond: (call: Call) => Response) {
  const calls: Call[] = [];
  const client = createApiClient({
    baseUrl: "http://test.local",
    fetchFn: async (input, init) => {
      const call = {
        method: init?.method ?? "GET",
        path: new URL(String(input)).pathname,
      };
      calls.push(call);
      return respond(call);
    },
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
  return { calls };
}

beforeEach(() => {
  usePreferencesStore.setState({ theme: "dark", grain: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SettingsPage", () => {
  it("shows Connected and a Disconnect button when Drive is connected", async () => {
    setup(() => json(connected));

    expect(await screen.findByText("Connected")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Disconnect" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Connect Google Drive" }),
    ).not.toBeInTheDocument();
  });

  it("shows a Connect button when configured but not connected", async () => {
    setup(() => json(notConnected));

    expect(await screen.findByText("Not connected")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Connect Google Drive" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Disconnect" }),
    ).not.toBeInTheDocument();
  });

  it("shows the reconnect hint when authorization needs renewing", async () => {
    setup(() => json(needsReconnect));

    expect(
      await screen.findByText("Drive authorization expired. Reconnect to continue."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Connect Google Drive" }),
    ).toBeInTheDocument();
  });

  it("shows a not-configured message and no Connect button", async () => {
    setup(() => json(notConfigured));

    expect(await screen.findByText(/not configured/i)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Connect Google Drive" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Disconnect" }),
    ).not.toBeInTheDocument();
  });

  it("fetches the consent URL same-origin, then navigates to it", async () => {
    const location = { href: "http://localhost/settings" };
    vi.stubGlobal("location", location);
    const { calls } = setup(({ path }) =>
      path === "/api/drive/connect"
        ? json({ url: "https://accounts.google.com/o/oauth2/auth?x=1" })
        : json(notConnected),
    );

    await userEvent.click(
      await screen.findByRole("button", { name: "Connect Google Drive" }),
    );

    await waitFor(() =>
      expect(location.href).toBe("https://accounts.google.com/o/oauth2/auth?x=1"),
    );
    expect(calls).toContainEqual({ method: "GET", path: "/api/drive/connect" });
  });

  it("shows the error when starting the connect flow fails", async () => {
    setup(({ path }) =>
      path === "/api/drive/connect"
        ? json({ error: "Drive OAuth is not configured" }, 409)
        : json(notConnected),
    );

    await userEvent.click(
      await screen.findByRole("button", { name: "Connect Google Drive" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Drive OAuth is not configured",
    );
  });

  it("disconnects and refreshes the Drive status", async () => {
    let isConnected = true;
    const { calls } = setup(({ method, path }) => {
      if (method === "POST" && path === "/api/drive/disconnect") {
        isConnected = false;
        return json({ disconnected: true });
      }
      return json(isConnected ? connected : notConnected);
    });

    await userEvent.click(
      await screen.findByRole("button", { name: "Disconnect" }),
    );

    expect(
      await screen.findByRole("button", { name: "Connect Google Drive" }),
    ).toBeInTheDocument();
    expect(calls).toContainEqual({
      method: "POST",
      path: "/api/drive/disconnect",
    });
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
