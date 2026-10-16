import { Text } from "@/components/atoms/Text";
import type { DetectScope } from "../types";
import styles from "./Builder.module.scss";

type DetectFilterProps = {
  value: DetectScope;
  onChange: (scope: DetectScope) => void;
};

const OPTIONS: readonly {
  scope: DetectScope;
  label: string;
  available: boolean;
}[] = [
  { scope: "images", label: "Images", available: true },
  { scope: "text", label: "Text", available: true },
  { scope: "links", label: "Links (coming soon)", available: false },
  { scope: "tables", label: "Tables (coming soon)", available: false },
];

export function DetectFilter({ value, onChange }: DetectFilterProps) {
  return (
    <fieldset className={styles.scope}>
      <legend className={styles.legend}>
        <Text variant="small" tone="secondary" as="span">
          Detect
        </Text>
      </legend>
      {OPTIONS.map((option) => (
        <label key={option.scope} className={styles.choice}>
          <input
            type="radio"
            name="detect-scope"
            value={option.scope}
            checked={value === option.scope}
            disabled={!option.available}
            onChange={() => onChange(option.scope)}
          />
          <Text variant="body" as="span">
            {option.label}
          </Text>
        </label>
      ))}
    </fieldset>
  );
}
