import { Text } from "@/components/atoms/Text";
import type { TextFieldEntry } from "../types";
import styles from "./Builder.module.scss";

type TextFieldListProps = {
  fields: readonly TextFieldEntry[];
  /** Field names switched off; everything else is included. */
  excluded: ReadonlySet<string>;
  onToggle: (name: string, include: boolean) => void;
};

export function TextFieldList({ fields, excluded, onToggle }: TextFieldListProps) {
  if (fields.length === 0) {
    return (
      <Text variant="body" tone="secondary">
        No text fields detected on this page.
      </Text>
    );
  }
  return (
    <>
      <Text variant="small" tone="secondary" role="note">
        Article mode captures the whole article. Field selection is recorded
        for reference but does not change what the run extracts yet.
      </Text>
      <ul className={styles.fieldList} aria-label="Detected text fields">
        {fields.map((field) => (
          <li key={field.name} className={styles.fieldItem}>
            <label className={styles.choice}>
              <input
                type="checkbox"
                checked={!excluded.has(field.name)}
                onChange={(event) => onToggle(field.name, event.target.checked)}
              />
              <Text variant="small" weight="semibold" as="span">
                {`Include ${field.name}`}
              </Text>
            </label>
            <pre className={styles.fieldValue}>{field.value}</pre>
          </li>
        ))}
      </ul>
    </>
  );
}
