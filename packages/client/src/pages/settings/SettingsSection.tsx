import { type ReactNode, useMemo } from "react";
import {
  renderSettingsSearchHighlight,
  SettingsSearchScopeProvider,
  useSettingsSearchScope,
} from "./SettingsSearchContext";
import { settingsTextMatches } from "./settingsSearchMatch";

export interface SettingsSectionProps {
  /** Section heading; searchable, rendered as the section `<h2>`. */
  title?: string;
  /** Section lede; searchable, rendered as `.settings-section-description`. */
  description?: string;
  /** Extra search-only terms; never rendered. */
  keywords?: string[];
  /** Extra classes appended to `settings-section`. */
  className?: string;
  children?: ReactNode;
}

/**
 * One settings section: optional `<h2>` + description ahead of its groups
 * and rows. In search results, a title/description match surfaces the whole
 * section operable (child rows stop filtering); otherwise children filter
 * individually and CSS hides the section when nothing inside matched.
 */
export function SettingsSection({
  title,
  description,
  keywords,
  className,
  children,
}: SettingsSectionProps) {
  const scope = useSettingsSearchScope();
  const sectionMatched = scope
    ? scope.sectionMatched ||
      settingsTextMatches(scope.query, [
        title,
        description,
        ...(keywords ?? []),
      ])
    : false;

  const childScope = useMemo(
    () =>
      scope
        ? {
            ...scope,
            sectionMatched,
            sectionTitle: title ?? scope.sectionTitle,
          }
        : null,
    [scope, sectionMatched, title],
  );

  const sectionClassName = [
    "settings-section",
    className,
    scope && sectionMatched ? "settings-search-section-match" : null,
  ]
    .filter(Boolean)
    .join(" ");

  const body = (
    <section className={sectionClassName}>
      {title && (
        <h2>
          {scope ? renderSettingsSearchHighlight(title, scope.query) : title}
        </h2>
      )}
      {description && (
        <p className="settings-section-description">
          {scope
            ? renderSettingsSearchHighlight(description, scope.query)
            : description}
        </p>
      )}
      {children}
    </section>
  );

  if (!childScope) return body;
  return (
    <SettingsSearchScopeProvider value={childScope}>
      {body}
    </SettingsSearchScopeProvider>
  );
}
