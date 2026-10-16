import type { ReactNode } from "react";
import styles from "./IconButton.module.scss";

type IconButtonProps = {
  label: string;
  onClick: () => void;
  children: ReactNode;
  title?: string;
  disabled?: boolean;
  busy?: boolean;
};

export function IconButton({
  label,
  onClick,
  children,
  title,
  disabled,
  busy,
}: IconButtonProps) {
  return (
    <button
      type="button"
      className={styles.button}
      onClick={onClick}
      disabled={disabled || busy}
      aria-label={label}
      title={title ?? label}
      data-busy={busy ? "true" : undefined}
    >
      {children}
    </button>
  );
}
