import type {
  GitBranchInfo,
  GitMergePreviewResult,
  GitMergeStrategy,
} from "@yep-anywhere/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api/client";
import { useI18n } from "../i18n";
import { Button } from "./ui/Button";
import { Modal } from "./ui/Modal";

type Translate = ReturnType<typeof useI18n>["t"];

interface GitBranchMergeModalProps {
  projectId: string;
  currentBranch: string;
  branches: GitBranchInfo[];
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: (branchName: string, strategy: GitMergeStrategy) => void;
}

const MERGE_STRATEGIES: Array<{
  key: GitMergeStrategy;
  labelKey:
    | "gitStatusMergeMethodMerge"
    | "gitStatusMergeMethodSquash"
    | "gitStatusMergeMethodRebase";
  descriptionKey:
    | "gitStatusMergeMethodMergeHelp"
    | "gitStatusMergeMethodSquashHelp"
    | "gitStatusMergeMethodRebaseHelp";
}> = [
  {
    key: "merge",
    labelKey: "gitStatusMergeMethodMerge",
    descriptionKey: "gitStatusMergeMethodMergeHelp",
  },
  {
    key: "squash",
    labelKey: "gitStatusMergeMethodSquash",
    descriptionKey: "gitStatusMergeMethodSquashHelp",
  },
  {
    key: "rebase",
    labelKey: "gitStatusMergeMethodRebase",
    descriptionKey: "gitStatusMergeMethodRebaseHelp",
  },
];

const DEFAULT_MERGE_STRATEGY = MERGE_STRATEGIES[0];

export function GitBranchMergeModal({
  projectId,
  currentBranch,
  branches,
  busy,
  error,
  onClose,
  onConfirm,
}: GitBranchMergeModalProps) {
  const { t } = useI18n();
  const [filter, setFilter] = useState("");
  const [selectedBranch, setSelectedBranch] = useState("");
  const [selectedStrategy, setSelectedStrategy] =
    useState<GitMergeStrategy>("merge");
  const [strategyMenuOpen, setStrategyMenuOpen] = useState(false);
  const [preview, setPreview] = useState<GitMergePreviewResult | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const strategyMenuRef = useRef<HTMLDivElement>(null);

  const branchGroups = useMemo(() => {
    const normalizedFilter = filter.trim().toLowerCase();
    const matchesFilter = (branch: GitBranchInfo) =>
      normalizedFilter.length === 0 ||
      branch.name.toLowerCase().includes(normalizedFilter);

    return [
      {
        key: "default",
        title: t("gitStatusBranchGroupDefault"),
        branches: branches.filter(
          (branch) => branch.group === "default" && matchesFilter(branch),
        ),
      },
      {
        key: "recent",
        title: t("gitStatusBranchGroupRecent"),
        branches: branches.filter(
          (branch) => branch.group === "recent" && matchesFilter(branch),
        ),
      },
      {
        key: "other",
        title: t("gitStatusBranchGroupOther"),
        branches: branches.filter(
          (branch) => branch.group === "other" && matchesFilter(branch),
        ),
      },
    ].filter((group) => group.branches.length > 0);
  }, [branches, filter, t]);

  const selectedStrategyOption =
    MERGE_STRATEGIES.find((strategy) => strategy.key === selectedStrategy) ??
    DEFAULT_MERGE_STRATEGY;

  if (!selectedStrategyOption) {
    return null;
  }

  useEffect(() => {
    if (!selectedBranch) {
      setPreview(null);
      setPreviewError(null);
      return;
    }

    let cancelled = false;
    setPreviewLoading(true);
    setPreviewError(null);

    void api
      .previewGitMerge(projectId, {
        sourceBranch: selectedBranch,
        strategy: selectedStrategy,
      })
      .then((response) => {
        if (cancelled) return;
        setPreview(response.result);
      })
      .catch((err) => {
        if (cancelled) return;
        setPreview(null);
        setPreviewError(
          err instanceof Error ? err.message : t("gitStatusActionFailed"),
        );
      })
      .finally(() => {
        if (cancelled) return;
        setPreviewLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [projectId, selectedBranch, selectedStrategy, t]);

  useEffect(() => {
    if (!strategyMenuOpen) return;

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (strategyMenuRef.current?.contains(target)) return;
      setStrategyMenuOpen(false);
    };

    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [strategyMenuOpen]);

  const handleConfirm = useCallback(() => {
    if (!selectedBranch) return;
    onConfirm(selectedBranch, selectedStrategy);
  }, [onConfirm, selectedBranch, selectedStrategy]);

  const canSubmit =
    !busy &&
    !previewLoading &&
    selectedBranch.length > 0 &&
    preview?.state === "mergeable";

  const statusState = error
    ? "error"
    : previewError
      ? "error"
      : previewLoading
        ? "loading"
        : (preview?.state ?? "idle");
  const showStatus = statusState !== "idle";

  return (
    <Modal
      title={t("gitStatusMergeDialogTitle", { branch: currentBranch })}
      onClose={onClose}
    >
      <div className="git-branch-merge-modal">
        <div className="git-branch-merge-filter">
          <div className="git-filter-bar">
            <div className="git-filter-field">
              <span className="git-filter-icon" aria-hidden="true">
                <SearchIcon />
              </span>
              <input
                type="text"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder={t("gitStatusMergeFilterPlaceholder")}
                className="git-filter-input"
              />
              {filter.length > 0 ? (
                <button
                  type="button"
                  className="git-filter-clear"
                  onClick={() => setFilter("")}
                  aria-label={t("activityClear")}
                >
                  <ClearIcon />
                </button>
              ) : null}
            </div>
          </div>
        </div>

        <div className="git-branch-merge-list">
          {branchGroups.length === 0 ? (
            <div className="git-branch-merge-empty">
              {t("gitStatusMergeDialogEmpty")}
            </div>
          ) : (
            branchGroups.map((group) => (
              <div key={group.key} className="git-branch-merge-group">
                <div className="git-branch-merge-group-title">
                  {group.title}
                </div>
                {group.branches.map((branch) => {
                  const isCurrent = branch.name === currentBranch;
                  const isSelected = selectedBranch === branch.name;

                  return (
                    <button
                      key={branch.name}
                      type="button"
                      className={`git-branch-merge-list-item ${
                        isSelected ? "is-selected" : ""
                      } ${isCurrent ? "is-current" : ""}`}
                      onClick={() => {
                        if (isCurrent) {
                          setSelectedBranch("");
                          return;
                        }
                        setSelectedBranch(branch.name);
                      }}
                    >
                      <span className="git-branch-merge-list-main">
                        <span
                          className="git-branch-merge-list-icon"
                          aria-hidden="true"
                        >
                          {isCurrent ? <CheckIcon /> : <BranchIcon />}
                        </span>
                        <span className="git-branch-merge-list-name">
                          {branch.name}
                        </span>
                      </span>
                      {branch.updatedAt ? (
                        <span className="git-branch-merge-list-time">
                          {formatRelativeTime(branch.updatedAt, t)}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        {showStatus ? (
          <div className={`git-branch-merge-status is-${statusState}`}>
            {statusState === "loading" ? (
              <p className="git-branch-merge-status-copy">
                {t("gitStatusMergeChecking")}
              </p>
            ) : statusState === "up_to_date" && preview ? (
              <>
                <StatusSuccessIcon />
                <p className="git-branch-merge-status-copy">
                  {highlightStatusText(
                    t("gitStatusMergeUpToDate", {
                      targetBranch: preview.targetBranch,
                      sourceBranch: preview.sourceBranch,
                    }),
                    [preview.targetBranch, preview.sourceBranch],
                  )}
                </p>
              </>
            ) : statusState === "conflict" && preview ? (
              <>
                <StatusWarningIcon />
                <p className="git-branch-merge-status-copy">
                  {highlightStatusText(
                    t("gitStatusMergeConflict", {
                      count: preview.conflictedFiles,
                      sourceBranch: preview.sourceBranch,
                      targetBranch: preview.targetBranch,
                    }),
                    [
                      t("gitStatusMergeConflictCountLabel", {
                        count: preview.conflictedFiles,
                      }),
                      preview.sourceBranch,
                      preview.targetBranch,
                    ],
                  )}
                </p>
              </>
            ) : statusState === "mergeable" && preview ? (
              <>
                <StatusSuccessIcon />
                <p className="git-branch-merge-status-copy">
                  {highlightStatusText(
                    t(
                      preview.strategy === "rebase"
                        ? "gitStatusMergeReadyRebase"
                        : "gitStatusMergeReady",
                      {
                        count: preview.commitCount,
                        sourceBranch: preview.sourceBranch,
                        targetBranch: preview.targetBranch,
                      },
                    ),
                    [
                      t("gitStatusMergeCommitCountLabel", {
                        count: preview.commitCount,
                      }),
                      preview.sourceBranch,
                      preview.targetBranch,
                    ],
                  )}
                </p>
              </>
            ) : statusState === "error" ? (
              <>
                <StatusWarningIcon />
                <p className="git-branch-merge-status-copy">
                  {error ?? previewError}
                </p>
              </>
            ) : null}
          </div>
        ) : null}

        <div className="git-branch-merge-actions">
          <div className="git-branch-merge-submit" ref={strategyMenuRef}>
            <Button
              variant="primary"
              className="git-branch-merge-submit-button"
              onClick={handleConfirm}
              disabled={!canSubmit}
            >
              {busy
                ? t("gitStatusMerging")
                : t(selectedStrategyOption.labelKey)}
            </Button>
            <Button
              variant="primary"
              className={`git-branch-merge-submit-toggle ${
                canSubmit ? "" : "is-inactive"
              }`}
              onClick={() => setStrategyMenuOpen((value) => !value)}
              disabled={busy}
              aria-label={t("gitStatusMergeMethodToggle")}
              aria-expanded={strategyMenuOpen}
              aria-haspopup="menu"
            >
              <ChevronDownIcon />
            </Button>
            {strategyMenuOpen ? (
              <div className="git-branch-merge-method-menu" role="menu">
                {MERGE_STRATEGIES.map((strategy) => (
                  <button
                    key={strategy.key}
                    type="button"
                    className={`git-branch-merge-method-item ${
                      selectedStrategy === strategy.key ? "is-selected" : ""
                    }`}
                    onClick={() => {
                      setSelectedStrategy(strategy.key);
                      setStrategyMenuOpen(false);
                    }}
                    role="menuitemradio"
                    aria-checked={selectedStrategy === strategy.key}
                  >
                    <span className="git-branch-merge-method-item-icon">
                      {selectedStrategy === strategy.key ? <CheckIcon /> : null}
                    </span>
                    <span className="git-branch-merge-method-item-body">
                      <span className="git-branch-merge-method-item-title">
                        {t(strategy.labelKey)}
                      </span>
                      <span className="git-branch-merge-method-item-description">
                        {t(strategy.descriptionKey)}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </Modal>
  );
}

function formatRelativeTime(timestamp: string, t: Translate): string {
  const now = Date.now();
  const then = new Date(timestamp).getTime();
  const diffMs = now - then;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  const diffMonths = Math.floor(diffDays / 30);
  const diffYears = Math.floor(diffDays / 365);

  if (diffMins < 1) return t("gitStatusRelativeNow");
  if (diffMins < 60) return t("gitStatusRelativeMinutes", { count: diffMins });
  if (diffHours < 24) return t("gitStatusRelativeHours", { count: diffHours });
  if (diffDays <= 30) return t("gitStatusRelativeDays", { count: diffDays });
  if (diffMonths < 12)
    return t("gitStatusRelativeMonths", { count: diffMonths });
  return t("gitStatusRelativeYears", { count: diffYears });
}

function highlightStatusText(text: string, tokens: string[]) {
  const uniqueTokens = [...new Set(tokens.filter(Boolean))].sort(
    (left, right) => right.length - left.length,
  );

  if (uniqueTokens.length === 0) return text;

  const parts: Array<string | { text: string; strong: true }> = [];
  let cursor = 0;

  while (cursor < text.length) {
    let matchedToken: string | null = null;

    for (const token of uniqueTokens) {
      if (text.startsWith(token, cursor)) {
        matchedToken = token;
        break;
      }
    }

    if (matchedToken) {
      parts.push({ text: matchedToken, strong: true });
      cursor += matchedToken.length;
      continue;
    }

    const nextCursor = cursor + 1;
    const previous = parts.at(-1);
    if (typeof previous === "string") {
      parts[parts.length - 1] = previous + text.slice(cursor, nextCursor);
    } else {
      parts.push(text.slice(cursor, nextCursor));
    }
    cursor = nextCursor;
  }

  return parts.map((part, index) =>
    typeof part === "string" ? (
      <span key={`text-${index}-${part}`}>{part}</span>
    ) : (
      <strong key={`strong-${index}-${part.text}`}>{part.text}</strong>
    ),
  );
}

function SearchIcon() {
  return (
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
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}

function ClearIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m5 12 5 5L20 7" />
    </svg>
  );
}

function BranchIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <line x1="6" y1="3" x2="6" y2="15" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </svg>
  );
}

function ChevronDownIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M12 16 5 8h14z" />
    </svg>
  );
}

function StatusSuccessIcon() {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m5 12 5 5L20 7" />
    </svg>
  );
}

function StatusWarningIcon() {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
    </svg>
  );
}
