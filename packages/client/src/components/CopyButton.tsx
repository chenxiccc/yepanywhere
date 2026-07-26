import { useEffect, useState } from "react";
import { writeClipboardText } from "../lib/clipboard";

/**
 * A small copy-to-clipboard button used by the source-control copy affordances
 * (branch name, commit hash, file path — topic: source-review-to-session). Shows
 * a transient check on success and stops click propagation so it can sit inside
 * a clickable row without also selecting the row.
 */
export function CopyButton({
  value,
  title,
  className,
}: {
  value: string;
  /** Tooltip + accessible label (e.g. "Copy branch name"). */
  title: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <button
      type="button"
      className={`copy-button ${copied ? "copied" : ""} ${className ?? ""}`}
      title={title}
      aria-label={title}
      onClick={async (event) => {
        event.stopPropagation();
        if (await writeClipboardText(value)) setCopied(true);
      }}
    >
      {copied ? (
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <polyline points="20 6 9 17 4 12" />
        </svg>
      ) : (
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      )}
    </button>
  );
}
