type TranslationFn = (
  key: string,
  vars?: Record<string, string | number>,
) => string;

/**
 * The source-control mode selector (topic: source-review-to-session, stage 3):
 * one surface, several navigation modes that all feed the same review
 * accumulator. `changes` is the working-tree diff (the default, preserved),
 * `commits` the commit browser, `files` the all-files blame browser,
 * `comments` the pending-review list. Only the modes with a built body are
 * passed in `tabs`, so no dead tab ever ships.
 */
export type SourceTab = "changes" | "commits" | "files" | "comments";

export function SourceModeTabs({
  tab,
  tabs,
  counts,
  onSelect,
  t,
}: {
  tab: SourceTab;
  tabs: readonly SourceTab[];
  /** Optional per-tab count chip (e.g. pending review comments). */
  counts?: Partial<Record<SourceTab, number>>;
  onSelect: (tab: SourceTab) => void;
  t: TranslationFn;
}) {
  return (
    <div className="source-mode-tabs" role="tablist">
      {tabs.map((key) => {
        const count = counts?.[key];
        return (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            className={`source-mode-tab ${tab === key ? "active" : ""}`}
            onClick={() => onSelect(key)}
          >
            {t(sourceTabLabelKey(key))}
            {typeof count === "number" && count > 0 && (
              <span className="source-mode-tab-count">{count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function sourceTabLabelKey(tab: SourceTab): string {
  switch (tab) {
    case "commits":
      return "sourceTabCommits";
    case "files":
      return "sourceTabFiles";
    case "comments":
      return "sourceTabComments";
    default:
      return "sourceTabChanges";
  }
}
