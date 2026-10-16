import { IconBase, type IconProps } from "./IconBase";

export function PlayIcon({ className }: IconProps) {
  return (
    <IconBase className={className}>
      <path d="M6 4l14 8-14 8z" />
    </IconBase>
  );
}
