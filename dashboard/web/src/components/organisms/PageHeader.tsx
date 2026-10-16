import type { ReactNode } from "react";
import { Text } from "@/components/atoms/Text";
import styles from "./PageHeader.module.scss";

type PageHeaderProps = {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
};

export function PageHeader({ title, subtitle, actions }: PageHeaderProps) {
  return (
    <header className={styles.header}>
      <div>
        <Text variant="display">{title}</Text>
        {subtitle ? (
          <Text variant="subtitle" tone="secondary" className={styles.subtitle}>
            {subtitle}
          </Text>
        ) : null}
      </div>
      {actions ? <div className={styles.actions}>{actions}</div> : null}
    </header>
  );
}
