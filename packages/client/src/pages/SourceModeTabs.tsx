type TranslationFn = (
  key: string,
  vars?: Record<string, string | number>,
) => string;

/**
 * The source-control mode selector (topic: source-review-to-session, stage 3):
 * one surface, several navigation modes that all feed the same review
 * accumulator. `changes` is the working-tree diff (the default, preserved),
 * `commits` the commit browser, `files` the all-files blame browser. Only the
 * modes with a built body are passed in `tabs`, so no dead tab ever ships.
 */
export type SourceTab = "changes" | "commits" | "files";

export function SourceModeTabs({
  tab,
  tabs,
  onSelect,
  t,
}: {
  tab: SourceTab;
  tabs: readonly SourceTab[];
  onSelect: (tab: SourceTab) => void;
  t: TranslationFn;
}) {
  return (
    <div className="source-mode-tabs" role="tablist">
      {tabs.map((key) => (
        <button
          key={key}
          type="button"
          role="tab"
          aria-selected={tab === key}
          className={`source-mode-tab ${tab === key ? "active" : ""}`}
          onClick={() => onSelect(key)}
        >
          {t(sourceTabLabelKey(key))}
        </button>
      ))}
    </div>
  );
}

function sourceTabLabelKey(tab: SourceTab): string {
  switch (tab) {
    case "commits":
      return "sourceTabCommits";
    case "files":
      return "sourceTabFiles";
    default:
      return "sourceTabChanges";
  }
}
