import { IconBase, type IconProps } from "./IconBase";

export function PauseIcon({ className }: IconProps) {
  return (
    <IconBase className={className}>
      <path d="M8 5v14M16 5v14" />
    </IconBase>
  );
}
