import type { ComponentType } from "react";
import { NavLink } from "react-router";
import { GearIcon } from "@/components/atoms/icons/GearIcon";
import { GridIcon } from "@/components/atoms/icons/GridIcon";
import type { IconProps } from "@/components/atoms/icons/IconBase";
import { ListIcon } from "@/components/atoms/icons/ListIcon";
import { Text } from "@/components/atoms/Text";
import { ThemeToggle } from "@/components/molecules/ThemeToggle";
import type { Theme } from "@/app/theme";
import { useHealth } from "@/features/health";
import { dashboardClient } from "@/lib/api-client";
import type { ApiClient } from "@/lib/http/api-client";
import styles from "./Sidebar.module.scss";

type NavItem = {
  to: string;
  label: string;
  icon: ComponentType<IconProps>;
  end?: boolean;
};

const NAV_ITEMS: NavItem[] = [
  { to: "/", label: "Runs", icon: GridIcon, end: true },
  { to: "/projects", label: "Projects", icon: ListIcon },
  { to: "/settings", label: "Settings", icon: GearIcon },
];

type SidebarProps = {
  theme: Theme;
  onToggleTheme: () => void;
  /** Injectable for tests; production uses the shared dashboard client. */
  client?: ApiClient;
};

type EngineStatus = "checking" | "connected" | "disconnected";

const ENGINE_LABELS: Record<EngineStatus, string> = {
  checking: "Checking engine…",
  connected: "Engine connected",
  disconnected: "Engine disconnected",
};

export function Sidebar({
  theme,
  onToggleTheme,
  client = dashboardClient,
}: SidebarProps) {
  const health = useHealth(client);
  const engine: EngineStatus = health.isPending
    ? "checking"
    : health.data?.ok
      ? "connected"
      : "disconnected";

  return (
    <aside className={styles.sidebar}>
      <Text as="div" variant="title" className={styles.brand}>
        Scrapr
      </Text>

      <nav aria-label="Primary" className={styles.nav}>
        <ul className={styles.list}>
          {NAV_ITEMS.map(({ to, label, icon: Icon, end }) => (
            <li key={to}>
              <NavLink
                to={to}
                end={end}
                className={({ isActive }) =>
                  isActive ? `${styles.link} ${styles.active}` : styles.link
                }
              >
                <Icon className={styles.icon} />
                {label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>

      <footer className={styles.footer}>
        <Text
          as="div"
          variant="small"
          tone="secondary"
          className={styles.status}
          role="status"
        >
          <span
            className={
              engine === "checking"
                ? styles.dot
                : `${styles.dot} ${styles[engine]}`
            }
            aria-hidden="true"
          />
          {ENGINE_LABELS[engine]}
        </Text>
        <ThemeToggle theme={theme} onToggle={onToggleTheme} />
      </footer>
    </aside>
  );
}
