import { Button } from "@/components/atoms/Button";
import { Text } from "@/components/atoms/Text";
import styles from "./Builder.module.scss";

type BuiltInRecipeNoticeProps = {
  /** Name of the built-in recipe that matched the previewed page. */
  profileName: string;
  onCreateRun: () => void;
  /** True while the project and run are being created. */
  creating?: boolean;
  /** Why creating failed, shown inline. */
  error?: string | null;
};

export function BuiltInRecipeNotice({
  profileName,
  onCreateRun,
  creating = false,
  error = null,
}: BuiltInRecipeNoticeProps) {
  return (
    <section className={styles.notice} role="note">
      <Text variant="body">
        {`This site has a built-in recipe (${profileName}). You can run it directly.`}
      </Text>
      <div>
        <Button variant="primary" onClick={onCreateRun} disabled={creating}>
          Create a run with the built-in recipe
        </Button>
      </div>
      {error ? (
        <Text variant="small" tone="negative" role="alert">
          {error}
        </Text>
      ) : null}
    </section>
  );
}
