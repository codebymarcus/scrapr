import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { applySizeRule, deriveSizeRule, draftToRules, EMPTY_DRAFT } from "../rules";
import { AD, CANDIDATES, HERO_1, ICON, thumbSrc } from "../test/fixtures";
import { ImageCandidateGrid } from "./ImageCandidateGrid";

const BASE = "http://test.local";

// Wires the grid the way BuilderPage does: picks derive the saved size rule.
function Harness() {
  const [kept, setKept] = useState(CANDIDATES.map(() => true));
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  return (
    <>
      <span aria-label="Derived min width" role="note">
        {draft.minWidth}
      </span>
      <ImageCandidateGrid
        candidates={CANDIDATES}
        kept={kept}
        rules={draftToRules(draft)}
        apiBase={BASE}
        onToggle={(index, keep) => {
          const next = kept.map((value, i) => (i === index ? keep : value));
          setKept(next);
          setDraft(applySizeRule(draft, deriveSizeRule(CANDIDATES, next)));
        }}
      />
    </>
  );
}

describe("ImageCandidateGrid", () => {
  it("shows each candidate through the thumbnail proxy with its dimensions", () => {
    render(
      <ImageCandidateGrid
        candidates={[HERO_1, ICON]}
        kept={[true, true]}
        rules={{}}
        apiBase={`${BASE}/`}
        onToggle={vi.fn()}
      />,
    );

    const first = screen.getByRole("img", { name: "Candidate image 1" });
    expect(first).toHaveAttribute("src", thumbSrc(BASE, HERO_1.url));
    // The raw url is never loaded directly.
    expect(first.getAttribute("src")).not.toBe(HERO_1.url);
    expect(screen.getByText("800 × 1200")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Candidate image 2" })).toHaveAttribute(
      "src",
      thumbSrc(BASE, ICON.url),
    );
  });

  it("passes the previewed page URL to the proxy as the Referer", () => {
    const page = "https://batcave.biz/event/world-war-hulk/1";
    render(
      <ImageCandidateGrid
        candidates={[HERO_1]}
        kept={[true]}
        rules={{}}
        apiBase={BASE}
        pageUrl={page}
        onToggle={vi.fn()}
      />,
    );
    expect(screen.getByRole("img", { name: "Candidate image 1" })).toHaveAttribute(
      "src",
      thumbSrc(BASE, HERO_1.url, page),
    );
  });

  it("reports the toggled candidate", async () => {
    const onToggle = vi.fn();
    render(
      <ImageCandidateGrid
        candidates={[HERO_1, AD]}
        kept={[true, true]}
        rules={{}}
        apiBase={BASE}
        onToggle={onToggle}
      />,
    );

    await userEvent.click(screen.getByRole("checkbox", { name: "Keep image 2" }));

    expect(onToggle).toHaveBeenCalledWith(1, false);
  });

  it("highlights what the current rule keeps", () => {
    render(
      <ImageCandidateGrid
        candidates={CANDIDATES}
        kept={CANDIDATES.map(() => true)}
        rules={{ minWidth: 500 }}
        apiBase={BASE}
        onToggle={vi.fn()}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent(
      "Rule keeps 2 of 4 images",
    );
    const items = screen.getAllByRole("listitem");
    expect(within(items[0]).getByText("Rule keeps")).toBeInTheDocument();
    expect(items[0]).toHaveAttribute("data-rule", "keep");
    expect(within(items[2]).getByText("Rule drops")).toBeInTheDocument();
    expect(items[2]).toHaveAttribute("data-rule", "drop");
  });

  it("raises the derived minWidth as the small and ad images are dropped", async () => {
    render(<Harness />);
    expect(screen.getByRole("status")).toHaveTextContent("Rule keeps 4 of 4");

    await userEvent.click(screen.getByRole("checkbox", { name: "Keep image 3" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Keep image 4" }));
    expect(screen.getByLabelText("Derived min width")).toHaveTextContent("800");
    expect(screen.getByRole("status")).toHaveTextContent("Rule keeps 2 of 4");

    // Keeping the ad again lowers the threshold to the ad's width.
    await userEvent.click(screen.getByRole("checkbox", { name: "Keep image 3" }));
    expect(screen.getByLabelText("Derived min width")).toHaveTextContent("300");
    expect(screen.getByRole("status")).toHaveTextContent("Rule keeps 3 of 4");
  });

  it("falls back to a placeholder when a thumbnail fails to load", () => {
    render(
      <ImageCandidateGrid
        candidates={[HERO_1, AD]}
        kept={[true, true]}
        rules={{}}
        apiBase={BASE}
        onToggle={vi.fn()}
      />,
    );

    fireEvent.error(screen.getByRole("img", { name: "Candidate image 1" }));

    expect(
      screen.getByRole("img", { name: "Candidate image 1 unavailable" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "Candidate image 1" })).toBeNull();
    // The rest of the grid is untouched.
    expect(screen.getByRole("img", { name: "Candidate image 2" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Keep image 1" })).toBeInTheDocument();
  });
});
