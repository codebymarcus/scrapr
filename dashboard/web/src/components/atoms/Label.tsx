import type { ReactNode } from "react";
import styles from "./Label.module.scss";

type LabelProps = {
  htmlFor: string;
  children: ReactNode;
};

export function Label({ htmlFor, children }: LabelProps) {
  return (
    <label htmlFor={htmlFor} className={styles.label}>
      {children}
    </label>
  );
}
