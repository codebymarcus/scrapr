import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { App } from "./App";
import { usePreferencesStore } from "@/stores/use-preferences-store";

beforeEach(() => {
  window.history.pushState({}, "", "/");
  usePreferencesStore.setState({ theme: "dark", grain: true });
});

describe("App shell", () => {
  it("renders the sidebar nav with links to each section", () => {
    render(<App />);

    const nav = screen.getByRole("navigation", { name: "Primary" });

    expect(within(nav).getByRole("link", { name: "Runs" })).toHaveAttribute(
      "href",
      "/",
    );
    expect(within(nav).getByRole("link", { name: "Projects" })).toHaveAttribute(
      "href",
      "/projects",
    );
    expect(within(nav).getByRole("link", { name: "Settings" })).toHaveAttribute(
      "href",
      "/settings",
    );
  });

  it("renders the Runs placeholder on the default route", () => {
    render(<App />);

    expect(screen.getByRole("heading", { name: "Runs" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Runs" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("navigates to the Projects route and marks the link current", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("link", { name: "Projects" }));

    expect(
      screen.getByRole("heading", { name: "Projects" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Projects" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("link", { name: "Runs" })).not.toHaveAttribute(
      "aria-current",
    );
  });

  it("renders the builder placeholder at /projects/new", () => {
    window.history.pushState({}, "", "/projects/new");
    render(<App />);

    expect(
      screen.getByRole("heading", { name: "New project" }),
    ).toBeInTheDocument();
  });

  it("shows the engine-connected indicator in the sidebar", () => {
    render(<App />);

    expect(screen.getByText(/engine connected/i)).toBeInTheDocument();
  });

  it("wires the theme toggle to the preferences store", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(
      screen.getByRole("button", { name: "Switch to light mode" }),
    );

    expect(usePreferencesStore.getState().theme).toBe("light");
    expect(
      screen.getByRole("button", { name: "Switch to dark mode" }),
    ).toBeInTheDocument();
  });
});
