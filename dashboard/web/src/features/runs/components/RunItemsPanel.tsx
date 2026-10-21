import { useState } from "react";
import { Button } from "@/components/atoms/Button";
import { SegmentedMeter } from "@/components/atoms/SegmentedMeter";
import { Text } from "@/components/atoms/Text";
import type { ApiClient } from "@/lib/http/api-client";
import type { RunItem } from "@/lib/schemas";
import { useItemActions } from "../hooks/use-item-actions";
import type { ItemActionResult } from "../hooks/use-item-actions";
import { deriveItemStatus, isUploaded } from "../types";
import type { RunContentType, RunItemStatus } from "../types";
import styles from "./RunItemsPanel.module.scss";

/** Rows rendered at once; keeps the DOM bounded for very large runs. */
export const ITEMS_PAGE_SIZE = 50;

const STATUS_LABEL: Record<RunItemStatus, string> = {
  completed: "Completed",
  pending: "Pending",
  skipped: "Skipped",
  failed: "Failed",
};

type RunItemsPanelProps = {
  runId: number;
  items: RunItem[];
  contentType: RunContentType;
  isRunning: boolean;
  /** Live page counter per in-flight item id (concurrent rows). */
  liveByItem?: Record<number, { current: number; total: number }>;
  /** Injectable for tests; production uses the shared dashboard client. */
  client?: ApiClient;
};

function itemLabel(item: RunItem): string {
  return item.name || item.url;
}

export function RunItemsPanel({
  runId,
  items,
  contentType,
  isRunning,
  liveByItem,
  client,
}: RunItemsPanelProps) {
  const actions = useItemActions(client);
  const [page, setPage] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const isImage = contentType === "image";
  const busy =
    actions.remove.isPending ||
    actions.upload.isPending ||
    actions.uploadPending.isPending ||
    actions.retry.isPending ||
    actions.retryItem.isPending;
  const locked = isRunning || busy;

  const pageCount = Math.max(1, Math.ceil(items.length / ITEMS_PAGE_SIZE));
  // The list can shrink under us (a removed item); never sit past the end.
  const currentPage = Math.min(page, pageCount - 1);
  const start = currentPage * ITEMS_PAGE_SIZE;
  const visible = items.slice(start, start + ITEMS_PAGE_SIZE);

  const hasUploadable = items.some(
    (item) => deriveItemStatus(item) === "completed" && !isUploaded(item),
  );
  const hasFailed = items.some((item) => deriveItemStatus(item) === "failed");

  // A 409 arrives as data; anything else rejects. Both land in the alert.
  async function perform(action: () => Promise<ItemActionResult<unknown>>) {
    setError(null);
    try {
      const result = await action();
      if (!result.ok) {
        setError(result.error);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Action failed");
    }
  }

  return (
    <section className={styles.panel} aria-label="Run items">
      <div className={styles.toolbar}>
        <Text variant="small" tone="secondary">
          {items.length} {items.length === 1 ? "item" : "items"}
        </Text>
        <div className={styles.bulk}>
          {isImage ? (
            <Button
              disabled={locked || !hasUploadable}
              onClick={() =>
                perform(() => actions.uploadPending.mutateAsync({ runId }))
              }
            >
              Upload all pending
            </Button>
          ) : null}
          <Button
            disabled={locked || !hasFailed}
            onClick={() => perform(() => actions.retry.mutateAsync({ runId }))}
          >
            Retry all failed
          </Button>
        </div>
      </div>

      {error ? (
        <Text variant="small" tone="negative" role="alert">
          {error}
        </Text>
      ) : null}

      <div className={styles.scroll}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">Item</th>
              <th scope="col">Status</th>
              <th scope="col">Progress</th>
              {isImage ? <th scope="col">Upload</th> : null}
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((item) => {
              const status = deriveItemStatus(item);
              const label = itemLabel(item);
              const live = liveByItem?.[item.id];
              const itemInput = { runId, itemId: item.id };
              return (
                <tr key={item.id}>
                  <td>
                    <div className={styles.name}>
                      <span className={styles.label}>{label}</span>
                      {(status === "failed" || status === "skipped") &&
                      item.reason ? (
                        <span className={styles.reason}>{item.reason}</span>
                      ) : null}
                    </div>
                  </td>
                  <td>
                    <span className={`${styles.badge} ${styles[status]}`}>
                      {STATUS_LABEL[status]}
                    </span>
                  </td>
                  <td>
                    {live ? (
                      <div className={styles.live}>
                        <SegmentedMeter
                          value={live.current}
                          total={live.total}
                          segments={12}
                          label={`${label} progress`}
                        />
                        <span className={styles.liveCounts}>
                          {live.current} / {live.total} pages
                        </span>
                      </div>
                    ) : null}
                  </td>
                  {isImage ? (
                    <td>
                      {status === "completed" ? (
                        <span
                          className={`${styles.badge} ${
                            isUploaded(item) ? styles.uploaded : styles.notUploaded
                          }`}
                        >
                          {isUploaded(item) ? "Uploaded" : "Not uploaded"}
                        </span>
                      ) : null}
                    </td>
                  ) : null}
                  <td>
                    <div className={styles.actions}>
                      {isImage &&
                      status === "completed" &&
                      !isUploaded(item) ? (
                        <Button
                          aria-label={`Upload ${label}`}
                          disabled={locked}
                          onClick={() =>
                            perform(() => actions.upload.mutateAsync(itemInput))
                          }
                        >
                          Upload
                        </Button>
                      ) : null}
                      {status === "failed" ? (
                        <Button
                          aria-label={`Retry ${label}`}
                          disabled={locked}
                          onClick={() =>
                            perform(() =>
                              actions.retryItem.mutateAsync(itemInput),
                            )
                          }
                        >
                          Retry
                        </Button>
                      ) : null}
                      {item.drive_link ? (
                        <a
                          className={styles.link}
                          href={item.drive_link}
                          target="_blank"
                          rel="noreferrer"
                          aria-label={`Open in Drive: ${label}`}
                        >
                          Open in Drive
                        </a>
                      ) : null}
                      {status === "pending" && !isRunning ? (
                        <Button
                          aria-label={`Remove ${label}`}
                          disabled={locked}
                          onClick={() =>
                            perform(() => actions.remove.mutateAsync(itemInput))
                          }
                        >
                          Remove
                        </Button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {pageCount > 1 ? (
        <nav className={styles.pager} aria-label="Items pagination">
          <Button
            disabled={currentPage === 0}
            onClick={() => setPage(currentPage - 1)}
          >
            Previous
          </Button>
          <Text variant="small" tone="secondary">
            Page {currentPage + 1} of {pageCount}
          </Text>
          <Button
            disabled={currentPage >= pageCount - 1}
            onClick={() => setPage(currentPage + 1)}
          >
            Next
          </Button>
        </nav>
      ) : null}
    </section>
  );
}
