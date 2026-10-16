import type { ReactNode } from "react";
import { Label } from "@/components/atoms/Label";
import styles from "./Field.module.scss";

type FieldProps = {
  htmlFor: string;
  label: string;
  children: ReactNode;
};

// Pairs a Label with its control; the control's id must equal `htmlFor`.
export function Field({ htmlFor, label, children }: FieldProps) {
  return (
    <div className={styles.field}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
    </div>
  );
}
