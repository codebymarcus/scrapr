import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ErrorState } from "./ErrorState";

describe("ErrorState", () => {
  it("shows the message inside an alert", () => {
    render(<ErrorState message="Server unreachable" />);
    expect(screen.getByRole("alert")).toHaveTextContent("Server unreachable");
  });

  it("calls onRetry when the retry button is clicked", async () => {
    const onRetry = vi.fn();
    render(<ErrorState message="boom" onRetry={onRetry} />);
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("omits the retry button without onRetry", () => {
    render(<ErrorState message="boom" />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("disables the button while retrying", () => {
    render(<ErrorState message="boom" onRetry={() => {}} isRetrying />);
    expect(screen.getByRole("button", { name: "Retrying..." })).toBeDisabled();
  });
});
