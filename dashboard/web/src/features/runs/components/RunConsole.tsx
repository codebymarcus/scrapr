import { useEffect, useRef } from "react";
import type { LogLine } from "../types";
import styles from "./RunConsole.module.scss";

// How close to the bottom (px) still counts as "following" the output.
const BOTTOM_THRESHOLD_PX = 24;

// Engine log levels that get a distinct look; anything else is plain.
const LEVEL_CLASS: Record<string, string> = {
  error: styles.error,
  warn: styles.warn,
  success: styles.success,
  muted: styles.muted,
  verbose: styles.muted,
  debug: styles.muted,
  section: styles.section,
  step: styles.step,
};

type RunConsoleProps = {
  logs: LogLine[];
};

/** Terminal-style view of a run's retained log lines, following the newest. */
export function RunConsole({ logs }: RunConsoleProps) {
  const scroller = useRef<HTMLOListElement | null>(null);
  // True while the user is at (or near) the bottom; a ref because scrolling
  // must not re-render the list.
  const atBottom = useRef(true);

  function handleScroll() {
    const el = scroller.current;
    if (!el) return;
    // jsdom has no layout (all zeros), which reads as "at bottom" here.
    atBottom.current =
      el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_THRESHOLD_PX;
  }

  const newest = logs.length > 0 ? logs[logs.length - 1].seq : null;
  useEffect(() => {
    const el = scroller.current;
    if (!el || newest === null || !atBottom.current) return;
    el.scrollTop = el.scrollHeight;
  }, [newest]);

  return (
    <ol
      ref={scroller}
      className={styles.console}
      role="log"
      aria-label="Run console"
      tabIndex={0}
      onScroll={handleScroll}
    >
      {logs.length === 0 ? (
        <li className={`${styles.line} ${styles.muted}`}>No output yet…</li>
      ) : (
        logs.map((line) => (
          <li key={line.seq} className={styles.row}>
            <span
              className={[styles.line, line.level && LEVEL_CLASS[line.level]]
                .filter(Boolean)
                .join(" ")}
            >
              {line.message}
            </span>
          </li>
        ))
      )}
    </ol>
  );
}
