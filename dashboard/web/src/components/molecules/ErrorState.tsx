import { Button } from "@/components/atoms/Button";
import { Text } from "@/components/atoms/Text";
import styles from "./ErrorState.module.scss";

type ErrorStateProps = {
  title?: string;
  message: string;
  onRetry?: () => void;
  isRetrying?: boolean;
};

export function ErrorState({
  title = "Something went wrong.",
  message,
  onRetry,
  isRetrying = false,
}: ErrorStateProps) {
  return (
    <section className={styles.container} role="alert">
      <Text variant="heading" as="h2" className={styles.title}>
        {title}
      </Text>
      <Text variant="body" className={styles.message}>
        {message}
      </Text>

      {onRetry ? (
        <Button onClick={onRetry} disabled={isRetrying}>
          {isRetrying ? "Retrying..." : "Try again"}
        </Button>
      ) : null}
    </section>
  );
}
