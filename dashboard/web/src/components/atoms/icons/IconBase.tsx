import type { ReactNode } from "react";

export type IconProps = { className?: string };

type IconBaseProps = IconProps & { children: ReactNode };

// Decorative 24-grid line icon: the control that wraps it carries the
// accessible label, so the glyph is hidden from assistive tech.
export function IconBase({ className, children }: IconBaseProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}
