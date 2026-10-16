import type { ReactNode } from "react";
import { PageHeader } from "@/components/organisms/PageHeader";
import styles from "./PageLayout.module.scss";

type PageLayoutProps = {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
};

export function PageLayout({
  title,
  subtitle,
  actions,
  children,
}: PageLayoutProps) {
  return (
    <main className={styles.main}>
      <PageHeader title={title} subtitle={subtitle} actions={actions} />
      {children}
    </main>
  );
}
