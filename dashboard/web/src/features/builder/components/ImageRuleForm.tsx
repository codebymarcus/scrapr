import { useId } from "react";
import { Text } from "@/components/atoms/Text";
import { TextInput } from "@/components/atoms/TextInput";
import { Field } from "@/components/molecules/Field";
import type { RuleDraft } from "../types";
import styles from "./Builder.module.scss";

type ImageRuleFormProps = {
  draft: RuleDraft;
  onChange: (draft: RuleDraft) => void;
};

/**
 * The rule that is actually saved. Selector and position rules only exist in
 * the preview (a run has no DOM to correlate them with), so they are shown
 * disabled rather than offered as something that would silently not apply.
 */
export function ImageRuleForm({ draft, onChange }: ImageRuleFormProps) {
  const ids = useId();

  function set<K extends keyof RuleDraft>(key: K, value: string) {
    onChange({ ...draft, [key]: value });
  }

  return (
    <section className={styles.panel} aria-labelledby={`${ids}-title`}>
      <Text variant="heading" as="h2" id={`${ids}-title`}>
        Image rule
      </Text>
      <Text variant="small" tone="secondary">
        Applied to every page of the run. Keeping or dropping images sets the
        size fields for you.
      </Text>
      <div className={styles.ruleFields}>
        <Field htmlFor={`${ids}-min-width`} label="Min width (px)">
          <TextInput
            id={`${ids}-min-width`}
            value={draft.minWidth}
            onChange={(value) => set("minWidth", value)}
            placeholder="e.g. 500"
          />
        </Field>
        <Field htmlFor={`${ids}-min-height`} label="Min height (px)">
          <TextInput
            id={`${ids}-min-height`}
            value={draft.minHeight}
            onChange={(value) => set("minHeight", value)}
            placeholder="e.g. 500"
          />
        </Field>
        <Field htmlFor={`${ids}-include-url`} label="Include URL containing">
          <TextInput
            id={`${ids}-include-url`}
            value={draft.includeUrl}
            onChange={(value) => set("includeUrl", value)}
            placeholder="e.g. /chapters/"
          />
        </Field>
        <Field htmlFor={`${ids}-exclude-url`} label="Exclude URL containing">
          <TextInput
            id={`${ids}-exclude-url`}
            value={draft.excludeUrl}
            onChange={(value) => set("excludeUrl", value)}
            placeholder="e.g. /ads/"
          />
        </Field>
      </div>
      <div className={styles.ruleFields}>
        <Field
          htmlFor={`${ids}-include-selector`}
          label="Include selector (preview-only)"
        >
          <TextInput
            id={`${ids}-include-selector`}
            value=""
            onChange={() => undefined}
            disabled
          />
        </Field>
        <Field
          htmlFor={`${ids}-exclude-selector`}
          label="Exclude selector (preview-only)"
        >
          <TextInput
            id={`${ids}-exclude-selector`}
            value=""
            onChange={() => undefined}
            disabled
          />
        </Field>
        <Field
          htmlFor={`${ids}-position`}
          label="Position range (preview-only)"
        >
          <TextInput
            id={`${ids}-position`}
            value=""
            onChange={() => undefined}
            disabled
          />
        </Field>
      </div>
      <Text variant="small" tone="secondary" role="note">
        Selector and position rules apply to the preview only; they are not
        saved or applied when the run executes.
      </Text>
    </section>
  );
}
