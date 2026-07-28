import type {
  ButtonHTMLAttributes,
  HTMLAttributes,
  ReactNode,
} from "react";
import { useTextTooltipAttributes } from "../hooks/useTooltipAppearance";
import type { MessageKey, TranslationFn } from "../i18n";

type SourceFileRowButtonProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "title"
> & {
  path: string;
  children: ReactNode;
};

/**
 * The row button owns the complete path tooltip. This keeps native and themed
 * tooltips working even when the visible path child is ellipsized.
 */
export function SourceFileRowButton({
  path,
  children,
  ...buttonProps
}: SourceFileRowButtonProps) {
  const tooltipAttributes = useTextTooltipAttributes(path);

  return (
    <button {...buttonProps} {...tooltipAttributes}>
      {children}
    </button>
  );
}

export function SourceFilePath({
  children,
  ...spanProps
}: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span {...spanProps} className="git-file-path">
      {children}
    </span>
  );
}

const STATUS_LABEL_KEYS: Record<string, MessageKey> = {
  M: "sourceFileStatusModified",
  A: "sourceFileStatusAdded",
  D: "sourceFileStatusDeleted",
  R: "sourceFileStatusRenamed",
  C: "sourceFileStatusCopied",
  T: "sourceFileStatusTypeChanged",
  U: "sourceFileStatusUnmerged",
  "?": "sourceFileStatusUntracked",
};

export function SourceFileStatusBadge({
  status,
  t,
}: {
  status: string;
  t: TranslationFn;
}) {
  const meaning = t(STATUS_LABEL_KEYS[status] ?? "sourceFileStatusChanged");
  const label = `${status} — ${meaning}`;
  const tooltipAttributes = useTextTooltipAttributes(label);

  return (
    <span
      className={`git-status-badge git-status-${status.toLowerCase()}`}
      role="img"
      aria-label={label}
      {...tooltipAttributes}
    >
      {status}
    </span>
  );
}
