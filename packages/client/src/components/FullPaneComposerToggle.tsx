import { useI18n } from "../i18n";
import { FULL_PANE_COMPOSER_SHORTCUT } from "../lib/composerTextarea";

interface FullPaneComposerToggleProps {
  expanded: boolean;
  onToggle: () => void;
  className?: string;
}

export function FullPaneComposerToggle({
  expanded,
  onToggle,
  className,
}: FullPaneComposerToggleProps) {
  const { t } = useI18n();

  return (
    <button
      type="button"
      className={className}
      onClick={onToggle}
      aria-label={t(
        expanded ? "composerFullPaneRestore" : "composerFullPaneExpand",
      )}
      aria-pressed={expanded}
      title={t(
        expanded
          ? "composerFullPaneRestoreTitle"
          : "composerFullPaneExpandTitle",
        { shortcut: FULL_PANE_COMPOSER_SHORTCUT },
      )}
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {expanded ? (
          <>
            <path d="M9 3v6H3" />
            <path d="m3 3 6 6" />
            <path d="M15 21v-6h6" />
            <path d="m21 21-6-6" />
          </>
        ) : (
          <>
            <path d="M8 3H3v5" />
            <path d="m3 3 6 6" />
            <path d="M16 21h5v-5" />
            <path d="m21 21-6-6" />
          </>
        )}
      </svg>
    </button>
  );
}
