import { Outlet } from "react-router";
import { Sidebar } from "@/components/organisms/Sidebar";
import { usePreferencesStore } from "@/stores/use-preferences-store";
import styles from "./AppLayout.module.scss";

export function AppLayout() {
  const theme = usePreferencesStore((state) => state.theme);
  const toggleTheme = usePreferencesStore((state) => state.toggleTheme);

  return (
    <div className={styles.shell}>
      <Sidebar theme={theme} onToggleTheme={toggleTheme} />
      <div className={styles.content}>
        <Outlet />
      </div>
    </div>
  );
}
