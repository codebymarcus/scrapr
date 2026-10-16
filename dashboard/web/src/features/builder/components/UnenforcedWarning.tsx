import { Text } from "@/components/atoms/Text";
import styles from "./Builder.module.scss";

type UnenforcedWarningProps = {
  /** `unenforcedRuleKeys` from the image preview. */
  keys: readonly string[];
};

export function UnenforcedWarning({ keys }: UnenforcedWarningProps) {
  if (keys.length === 0) {
    return null;
  }
  return (
    <Text variant="small" tone="negative" role="status" className={styles.warning}>
      These rules preview only, not applied at run: {keys.join(", ")}
    </Text>
  );
}
