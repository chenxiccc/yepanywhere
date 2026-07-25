import {
  memo,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useI18n } from "../../i18n";
import { SettingsCategoryItem } from "./SettingsCategoryItem";
import { SettingsPaneTitleProvider } from "./SettingsPaneTitleContext";
import {
  type SettingsSearchScope,
  SettingsSearchScopeProvider,
} from "./SettingsSearchContext";
import {
  type SettingsUndoRegistration,
  SettingsUndoProvider,
} from "./SettingsUndoContext";
import { settingsTextMatches } from "./settingsSearchMatch";
import type { SettingsCategory } from "./types";

const noopSetPaneTitle = (_title: string | null) => {};
const noopSetUndoRegistration = (
  _registration: SettingsUndoRegistration | null,
) => {};

/**
 * Memoized pane mount: the pane re-renders only when its component changes,
 * not on every keystroke — per-row filtering flows through the search scope
 * context, so only SettingsItem/SettingsSection consumers recompute.
 */
const SettingsSearchPaneMount = memo(function SettingsSearchPaneMount({
  Component,
}: {
  Component: React.ComponentType;
}) {
  return (
    <SettingsPaneTitleProvider value={noopSetPaneTitle}>
      <SettingsUndoProvider value={noopSetUndoRegistration}>
        <Component />
      </SettingsUndoProvider>
    </SettingsPaneTitleProvider>
  );
});

export interface SettingsSearchResultsProps {
  categories: SettingsCategory[];
  components: Record<string, React.ComponentType>;
  /** Trimmed, non-empty query (deferred value — may trail the input). */
  query: string;
  matchValues: boolean;
  /** Open a category pane at a specific row (from a result's jump link). */
  onJumpToItem: (categoryId: string, itemId: string) => void;
  /** Open a category pane at the top (category-level result). */
  onOpenCategory: (categoryId: string) => void;
}

/**
 * Live-filtered settings search results: matching categories first, then
 * every category pane mounted for real — matched rows stay operable in
 * place — grouped under a clickable category heading. Panes and sections
 * with no match are hidden by the settings-search CSS rules.
 */
export function SettingsSearchResults({
  categories,
  components,
  query,
  matchValues,
  onJumpToItem,
  onOpenCategory,
}: SettingsSearchResultsProps) {
  const { t } = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);
  const [matchCount, setMatchCount] = useState<number | null>(null);

  const categoryMatches = categories.filter((category) =>
    settingsTextMatches(query, [category.label, category.description]),
  );

  // Row matching happens inside each pane; count the committed results here
  // (a contained DOM read, no DOM writes) for the no-results state and the
  // screen-reader announcement.
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    setMatchCount(
      container.querySelectorAll(".settings-item.settings-search-match")
        .length,
    );
  }, [query, matchValues]);

  const hasResults =
    categoryMatches.length > 0 || matchCount === null || matchCount > 0;

  return (
    <div className="settings-search-results">
      {categoryMatches.length > 0 && (
        <div className="settings-search-category-matches">
          <h3 className="settings-search-heading">
            {t("settingsSearchCategoriesHeading")}
          </h3>
          <div className="settings-category-list">
            {categoryMatches.map((category) => (
              <SettingsCategoryItem
                key={category.id}
                category={category}
                isActive={false}
                onClick={() => onOpenCategory(category.id)}
                highlightQuery={query}
              />
            ))}
          </div>
        </div>
      )}
      <div ref={containerRef}>
        {categories.map((category) => {
          const Component = components[category.id];
          if (!Component) return null;
          return (
            <SettingsSearchPane
              key={category.id}
              category={category}
              Component={Component}
              query={query}
              matchValues={matchValues}
              onJumpToItem={onJumpToItem}
              onOpenCategory={onOpenCategory}
            />
          );
        })}
      </div>
      {!hasResults && (
        <p className="settings-search-no-results">
          {t("settingsSearchNoResults", { query })}
        </p>
      )}
      <span className="settings-search-live-count" aria-live="polite">
        {t("settingsSearchResultCount", {
          count: (matchCount ?? 0) + categoryMatches.length,
        })}
      </span>
    </div>
  );
}

interface SettingsSearchPaneProps {
  category: SettingsCategory;
  Component: React.ComponentType;
  query: string;
  matchValues: boolean;
  onJumpToItem: (categoryId: string, itemId: string) => void;
  onOpenCategory: (categoryId: string) => void;
}

function SettingsSearchPane({
  category,
  Component,
  query,
  matchValues,
  onJumpToItem,
  onOpenCategory,
}: SettingsSearchPaneProps) {
  const scope = useMemo<SettingsSearchScope>(
    () => ({
      query,
      matchValues,
      sectionMatched: false,
      categoryLabel: category.label,
      jumpToItem: (itemId: string) => onJumpToItem(category.id, itemId),
    }),
    [query, matchValues, category.id, category.label, onJumpToItem],
  );

  return (
    <section className="settings-search-pane" data-category={category.id}>
      <h3 className="settings-search-pane-title">
        <button type="button" onClick={() => onOpenCategory(category.id)}>
          {category.label} ›
        </button>
      </h3>
      <SettingsSearchScopeProvider value={scope}>
        <SettingsSearchPaneMount Component={Component} />
      </SettingsSearchScopeProvider>
    </section>
  );
}
