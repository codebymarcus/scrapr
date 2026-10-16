import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { draftToRules, EMPTY_DRAFT } from "../rules";
import { CANDIDATES } from "../test/fixtures";
import { ImageCandidateGrid } from "./ImageCandidateGrid";
import { ImageRuleForm } from "./ImageRuleForm";

function Harness() {
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  return (
    <>
      <ImageRuleForm draft={draft} onChange={setDraft} />
      <ImageCandidateGrid
        candidates={CANDIDATES}
        kept={CANDIDATES.map(() => true)}
        rules={draftToRules(draft)}
        apiBase="http://test.local"
        onToggle={() => undefined}
      />
    </>
  );
}

describe("ImageRuleForm", () => {
  it("changes which candidates are highlighted as the rule is edited", async () => {
    render(<Harness />);
    expect(screen.getByRole("status")).toHaveTextContent("Rule keeps 4 of 4");

    await userEvent.type(screen.getByLabelText("Min width (px)"), "500");
    expect(screen.getByRole("status")).toHaveTextContent("Rule keeps 2 of 4");

    await userEvent.clear(screen.getByLabelText("Min width (px)"));
    await userEvent.type(screen.getByLabelText("Exclude URL containing"), "ads/");
    expect(screen.getByRole("status")).toHaveTextContent("Rule keeps 3 of 4");

    await userEvent.type(screen.getByLabelText("Include URL containing"), "hero");
    expect(screen.getByRole("status")).toHaveTextContent("Rule keeps 2 of 4");
  });

  it("marks selector and position inputs preview-only and disabled", () => {
    render(<Harness />);

    for (const label of [
      "Include selector (preview-only)",
      "Exclude selector (preview-only)",
      "Position range (preview-only)",
    ]) {
      expect(screen.getByLabelText(label)).toBeDisabled();
    }
    expect(screen.getByLabelText("Min width (px)")).toBeEnabled();
  });
});
