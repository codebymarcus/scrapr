import { IconButton } from "@/components/atoms/IconButton";
import { MoonIcon } from "@/components/atoms/icons/MoonIcon";
import { SunIcon } from "@/components/atoms/icons/SunIcon";

type Theme = "light" | "dark";

type ThemeToggleProps = {
  theme: Theme;
  onToggle: () => void;
};

export function ThemeToggle({ theme, onToggle }: ThemeToggleProps) {
  const nextTheme: Theme = theme === "light" ? "dark" : "light";

  return (
    <IconButton label={`Switch to ${nextTheme} mode`} onClick={onToggle}>
      {theme === "light" ? <MoonIcon /> : <SunIcon />}
    </IconButton>
  );
}
