import { IconBase, type IconProps } from "./IconBase";

export function ListIcon({ className }: IconProps) {
  return (
    <IconBase className={className}>
      <path d="M8 6h13M8 12h13M8 18h13" />
      <path d="M3 6h.01M3 12h.01M3 18h.01" />
    </IconBase>
  );
}
