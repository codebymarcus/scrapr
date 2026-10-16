import type { ComponentType } from "react";
import { NavLink } from "react-router";
import { GearIcon } from "@/components/atoms/icons/GearIcon";
import { GridIcon } from "@/components/atoms/icons/GridIcon";
import type { IconProps } from "@/components/atoms/icons/IconBase";
import { ListIcon } from "@/components/atoms/icons/ListIcon";
import { Text } from "@/components/atoms/Text";
import { ThemeToggle } from "@/components/molecules/ThemeToggle";
import type { Theme } from "@/app/theme";
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
};

export function Sidebar({ theme, onToggleTheme }: SidebarProps) {
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
        <Text as="div" variant="small" tone="secondary" className={styles.status}>
          <span className={styles.dot} aria-hidden="true" />
          Engine connected
        </Text>
        <ThemeToggle theme={theme} onToggle={onToggleTheme} />
      </footer>
    </aside>
  );
}
