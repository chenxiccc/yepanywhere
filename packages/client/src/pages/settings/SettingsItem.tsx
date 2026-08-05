import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useI18n } from "../../i18n";
import {
  renderSettingsSearchHighlight,
  useSettingsJumpTarget,
  useSettingsSearchScope,
} from "./SettingsSearchContext";
import { settingsItemSlug, settingsTextMatches } from "./settingsSearchMatch";

export interface SettingsItemProps {
  /**
   * Stable jump/search id. Defaults to a slug of `label`; pass explicitly
   * when the label is dynamic or duplicated within the pane.
   */
  id?: string;
  /**
   * Row element tag. Use "label" for click-anywhere-toggles rows that wrap
   * their checkbox (the search jump link stays safe inside a label: clicks
   * on interactive descendants do not activate the labeled control).
   */
  as?: "div" | "label";
  /** Native tooltip on the row container (rarely needed). */
  title?: string;
  /** Plain-text row title; searchable and rendered bold. */
  label: string;
  /** Plain-text row description; searchable and rendered under the title. */
  description?: string;
  /** Extra search-only terms (synonyms, old names); never rendered. */
  keywords?: string[];
  /**
   * Current value as display text (e.g. the selected option's label).
   * Matched only when the user enables the search "match values" toggle;
   * never rendered by this component.
   */
  valueText?: string;
  /** Extra classes appended to `settings-item` (e.g. width modifiers). */
  className?: string;
  /**
   * Custom info-block body for rows whose info is richer than
   * bold-label + description. `label`/`description` still drive search
   * matching, but custom info is rendered as-is (no highlighting).
   */
  info?: ReactNode;
  /** The row's control(s), rendered as siblings of the info block. */
  children?: ReactNode;
  /**
   * Row-owned trailing content (hints, warnings) rendered after the row
   * container. In search results it appears only when the row matched.
   */
  after?: ReactNode;
  /**
   * When false, the row is omitted from settings search results (including
   * section-wide matches). Use for convenience clones of a control that
   * already has a primary searchable home elsewhere. Default true.
   */
  searchable?: boolean;
}

const JUMP_FLASH_DURATION_MS = 1800;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * One settings row: info block (label + description) plus its control.
 * Renders today's `.settings-item` markup unchanged in normal panes; inside
 * the settings search results it filters itself against the query,
 * highlights matched substrings, and offers a jump link to its home pane.
 */
export function SettingsItem({
  id,
  as: RowElement = "div",
  title,
  label,
  description,
  keywords,
  valueText,
  className,
  info,
  children,
  after,
  searchable = true,
}: SettingsItemProps) {
  const { t } = useI18n();
  const scope = useSettingsSearchScope();
  const jump = useSettingsJumpTarget();
  const resolvedId = id ?? settingsItemSlug(label);
  const ref = useRef<HTMLElement | null>(null);
  const setRef = useCallback((element: HTMLElement | null) => {
    ref.current = element;
  }, []);
  const [flash, setFlash] = useState(false);

  const jumpTargetsThisRow = !scope && jump?.target === resolvedId;
  const consume = jump?.consume;
  useEffect(() => {
    if (!jumpTargetsThisRow || !consume) return;
    consume();
    ref.current?.scrollIntoView({
      block: "center",
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    });
    setFlash(true);
  }, [jumpTargetsThisRow, consume]);

  useEffect(() => {
    if (!flash) return;
    const timer = setTimeout(() => setFlash(false), JUMP_FLASH_DURATION_MS);
    return () => clearTimeout(timer);
  }, [flash]);

  // Convenience clones stay out of search entirely so only the primary row hits.
  if (scope && !searchable) return null;

  const matched = scope
    ? scope.sectionMatched ||
      settingsTextMatches(scope.query, [
        label,
        description,
        ...(keywords ?? []),
        ...(scope.matchValues && valueText ? [valueText] : []),
      ])
    : false;
  if (scope && !matched) return null;

  const infoBody =
    info ??
    (scope ? (
      <>
        <strong>{renderSettingsSearchHighlight(label, scope.query)}</strong>
        {description && (
          <p>{renderSettingsSearchHighlight(description, scope.query)}</p>
        )}
      </>
    ) : (
      <>
        <strong>{label}</strong>
        {description && <p>{description}</p>}
      </>
    ));

  const originLabel = scope
    ? scope.sectionTitle
      ? `${scope.categoryLabel} › ${scope.sectionTitle}`
      : scope.categoryLabel
    : null;

  const itemClassName = [
    "settings-item",
    className,
    scope ? "settings-search-match" : null,
    flash ? "settings-item--jump-flash" : null,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <>
      <RowElement
        className={itemClassName}
        data-settings-item={resolvedId}
        title={title}
        ref={setRef}
      >
        <div className="settings-item-info">
          {infoBody}
          {scope && originLabel && (
            <button
              type="button"
              className="settings-search-origin"
              aria-label={t("settingsSearchJumpTo", { location: originLabel })}
              onClick={() => scope.jumpToItem(resolvedId)}
            >
              {originLabel} ›
            </button>
          )}
        </div>
        {children}
      </RowElement>
      {after}
    </>
  );
}
