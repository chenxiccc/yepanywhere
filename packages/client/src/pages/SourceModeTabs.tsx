import type { MessageKey, TranslationFn } from "../i18n";
import styles from "./SourceModeTabs.module.css";

/**
 * The source-control mode selector (topic: source-review-to-session, stage 3):
 * one surface, several navigation modes that all feed the same review
 * accumulator. `changes` owns both the current working tree and explicitly
 * opened commit history, `files` is the all-files blame browser, and
 * `comments` is the pending-review list.
 */
export type SourceTab = "changes" | "files" | "comments";

export function SourceModeTabs({
  tab,
  tabs,
  counts,
  onSelect,
  variant = "header",
  t,
}: {
  tab: SourceTab;
  tabs: readonly SourceTab[];
  /** Optional per-tab count chip (e.g. pending review comments). */
  counts?: Partial<Record<SourceTab, number>>;
  onSelect: (tab: SourceTab) => void;
  /**
   * `header` sits inline at the top-right of a wide page header. `stacked` is
   * the phone layout, where the strip becomes a full-width row of its own.
   */
  variant?: "header" | "stacked";
  t: TranslationFn;
}) {
  return (
    <div
      className={`${styles.tabs} ${
        variant === "stacked" ? styles.stacked : ""
      }`.trimEnd()}
      role="tablist"
    >
      {tabs.map((key) => {
        const count = counts?.[key];
        return (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            className={`${styles.tab} ${tab === key ? styles.active : ""}`.trimEnd()}
            onClick={() => onSelect(key)}
          >
            {t(sourceTabLabelKey(key))}
            {typeof count === "number" && count > 0 && (
              <span className={styles.count}>{count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function sourceTabLabelKey(tab: SourceTab): MessageKey {
  switch (tab) {
    case "changes":
      return "sourceTabChanges";
    case "files":
      return "sourceTabFiles";
    case "comments":
      return "sourceTabComments";
  }
}
