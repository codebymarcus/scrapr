import { IconBase, type IconProps } from "./IconBase";

export function RefreshIcon({ className }: IconProps) {
  return (
    <IconBase className={className}>
      <path d="M21 12a9 9 0 0 1-15.5 6.2L3 16" />
      <path d="M3 21v-5h5" />
      <path d="M3 12A9 9 0 0 1 18.5 5.8L21 8" />
      <path d="M21 3v5h-5" />
    </IconBase>
  );
}
