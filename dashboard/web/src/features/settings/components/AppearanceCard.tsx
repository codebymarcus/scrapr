import { Text } from "@/components/atoms/Text";
import { usePreferencesStore } from "@/stores/use-preferences-store";
import styles from "./SettingsPage.module.scss";

export function AppearanceCard() {
  const theme = usePreferencesStore((state) => state.theme);
  const grain = usePreferencesStore((state) => state.grain);
  const setTheme = usePreferencesStore((state) => state.setTheme);
  const setGrain = usePreferencesStore((state) => state.setGrain);

  return (
    <section className={styles.card} aria-labelledby="appearance-title">
      <Text as="h2" variant="heading" id="appearance-title">
        Appearance
      </Text>

      <ul className={styles.toggles}>
        <li>
          <label className={styles.toggle}>
            <input
              type="checkbox"
              role="switch"
              className={styles.switch}
              checked={theme === "dark"}
              onChange={(event) =>
                setTheme(event.target.checked ? "dark" : "light")
              }
            />
            <Text as="span" variant="body">
              Dark theme
            </Text>
          </label>
        </li>
        <li>
          <label className={styles.toggle}>
            <input
              type="checkbox"
              role="switch"
              className={styles.switch}
              checked={grain}
              onChange={(event) => setGrain(event.target.checked)}
            />
            <Text as="span" variant="body">
              Film grain
            </Text>
          </label>
        </li>
      </ul>
    </section>
  );
}
