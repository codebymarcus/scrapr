import { useState } from "react";
import { Text } from "@/components/atoms/Text";
import { API_BASE } from "@/lib/api-base";
import { keepsCandidate } from "../rules";
import type { ImageCandidate, ImageRules } from "../types";
import styles from "./ImageCandidateGrid.module.scss";

type ImageCandidateGridProps = {
  candidates: readonly ImageCandidate[];
  /** The operator's keep/drop pick per candidate (same order). */
  kept: readonly boolean[];
  /** The rule currently in the form; the grid shows what it would keep. */
  rules: ImageRules;
  onToggle: (index: number, keep: boolean) => void;
  /** Injectable for tests; production uses the configured dashboard origin. */
  apiBase?: string;
};

// Candidate images are loaded through the server's proxy: it sets a Referer
// and caps size, and the browser never touches the (possibly hotlink
// protected) origin directly.
function thumbUrl(apiBase: string, url: string): string {
  return `${apiBase.replace(/\/+$/, "")}/api/thumb?url=${encodeURIComponent(url)}`;
}

function Thumbnail({ src, number }: { src: string; number: number }) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <div
        className={styles.placeholder}
        role="img"
        aria-label={`Candidate image ${number} unavailable`}
      >
        <Text variant="caption" tone="secondary" as="span">
          No preview
        </Text>
      </div>
    );
  }
  return (
    <img
      className={styles.thumb}
      src={src}
      alt={`Candidate image ${number}`}
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}

function describeSize(candidate: ImageCandidate): string {
  return candidate.width !== undefined && candidate.height !== undefined
    ? `${candidate.width} × ${candidate.height}`
    : "Size unknown";
}

export function ImageCandidateGrid({
  candidates,
  kept,
  rules,
  onToggle,
  apiBase = API_BASE,
}: ImageCandidateGridProps) {
  const verdicts = candidates.map((candidate) => keepsCandidate(candidate, rules));
  const keptCount = verdicts.filter(Boolean).length;

  return (
    <section className={styles.section}>
      <Text variant="small" tone="secondary" role="status" aria-label="Rule result">
        Rule keeps {keptCount} of {candidates.length} images
      </Text>
      <ul className={styles.grid}>
        {candidates.map((candidate, index) => {
          const number = index + 1;
          const ruleKeeps = verdicts[index];
          return (
            <li
              // Candidates can repeat a url (the same image twice on a page).
              key={`${index}-${candidate.url}`}
              className={`${styles.item} ${ruleKeeps ? styles.ruleKeeps : styles.ruleDrops}`}
              data-rule={ruleKeeps ? "keep" : "drop"}
            >
              <Thumbnail src={thumbUrl(apiBase, candidate.url)} number={number} />
              <Text variant="small" tone="secondary" className={styles.size}>
                {describeSize(candidate)}
              </Text>
              <Text
                variant="caption"
                tone={ruleKeeps ? "positive" : "secondary"}
                className={styles.verdict}
              >
                {ruleKeeps ? "Rule keeps" : "Rule drops"}
              </Text>
              <label className={styles.keep}>
                <input
                  type="checkbox"
                  checked={kept[index] ?? true}
                  onChange={(event) => onToggle(index, event.target.checked)}
                />
                <Text variant="small" as="span">{`Keep image ${number}`}</Text>
              </label>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
