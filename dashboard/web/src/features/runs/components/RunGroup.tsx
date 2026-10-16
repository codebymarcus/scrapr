import { Children, useId } from "react";
import type { ReactNode } from "react";
import { Text } from "@/components/atoms/Text";
import styles from "./RunGroup.module.scss";

type RunGroupProps = {
  label: string;
  children: ReactNode;
};

export function RunGroup({ label, children }: RunGroupProps) {
  const headingId = useId();

  if (Children.count(children) === 0) {
    return null;
  }

  return (
    <section aria-labelledby={headingId} className={styles.group}>
      <Text variant="subtitle" as="h2" weight="semibold" id={headingId}>
        {label}
      </Text>
      <ul className={styles.list}>
        {Children.map(children, (child) => (
          <li className={styles.item}>{child}</li>
        ))}
      </ul>
    </section>
  );
}
