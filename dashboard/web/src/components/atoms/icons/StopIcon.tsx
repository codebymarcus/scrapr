import { IconBase, type IconProps } from "./IconBase";

export function StopIcon({ className }: IconProps) {
  return (
    <IconBase className={className}>
      <rect x="5" y="5" width="14" height="14" rx="1" />
    </IconBase>
  );
}
