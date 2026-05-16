import type { GitBranchInfo } from "@yep-anywhere/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { Button } from "./ui/Button";
import { Modal } from "./ui/Modal";

interface GitBranchCreateModalProps {
  currentBranch: string;
  branches: GitBranchInfo[];
  initialBranchName?: string;
  busy: boolean;
  onClose: () => void;
  onConfirm: (branchName: string, baseBranch: string) => void;
}

export function GitBranchCreateModal({
  currentBranch,
  branches,
  initialBranchName,
  busy,
  onClose,
  onConfirm,
}: GitBranchCreateModalProps) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);
  const [branchName, setBranchName] = useState(initialBranchName ?? "");
  const defaultBranch =
    branches.find((branch) => branch.group === "default")?.name ?? "main";
  const isOnDefaultBranch = currentBranch === defaultBranch;
  const baseOptions = useMemo(() => {
    const options = [
      {
        key: defaultBranch,
        name: defaultBranch,
        title: t("gitStatusBranchCreateBaseDefaultTitle", {
          branch: defaultBranch,
        }),
        description: t("gitStatusBranchCreateBaseDefaultHelp"),
      },
    ];

    if (currentBranch !== defaultBranch) {
      options.push({
        key: currentBranch,
        name: currentBranch,
        title: t("gitStatusBranchCreateBaseCurrentTitle", {
          branch: currentBranch,
        }),
        description: t("gitStatusBranchCreateBaseCurrentHelp"),
      });
    }

    return options;
  }, [currentBranch, defaultBranch, t]);
  const [selectedBaseBranch, setSelectedBaseBranch] = useState(defaultBranch);

  useEffect(() => {
    setSelectedBaseBranch(defaultBranch);
  }, [defaultBranch]);

  useEffect(() => {
    setBranchName(initialBranchName ?? "");
  }, [initialBranchName]);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;

    input.focus();
    const end = input.value.length;
    input.setSelectionRange(end, end);
  }, []);

  const normalizedName = branchName.trim().toLowerCase();
  const branchExists = branches.some(
    (branch) => branch.name.toLowerCase() === normalizedName,
  );
  const validationError =
    branchName.trim().length === 0
      ? t("gitStatusBranchCreateNameRequired")
      : normalizedName.startsWith("origin/")
        ? t("gitStatusBranchCreateNameInvalid")
        : branchExists
          ? t("gitStatusBranchCreateNameExists", {
              branch: branchName.trim(),
            })
          : null;

  return (
    <Modal title={t("gitStatusBranchCreateDialogTitle")} onClose={onClose}>
      <div className="git-branch-create-modal">
        <div className="git-branch-create-section">
          <label
            className="git-branch-create-label"
            htmlFor="git-branch-create-name"
          >
            {t("gitStatusBranchCreateNameLabel")}
          </label>
          <input
            ref={inputRef}
            id="git-branch-create-name"
            type="text"
            value={branchName}
            onChange={(event) => setBranchName(event.target.value)}
            className="git-branch-create-input"
          />
          {validationError ? (
            <p className="git-branch-create-help is-error">{validationError}</p>
          ) : (
            <p className="git-branch-create-help">
              {t("gitStatusBranchCreateHelp")}
            </p>
          )}
        </div>

        {isOnDefaultBranch ? (
          <div className="git-branch-create-section">
            <p className="git-branch-create-default-copy">
              {t("gitStatusBranchCreateDefaultBranchNoticeBefore")}
              <code>{currentBranch}</code>
              {t("gitStatusBranchCreateDefaultBranchNoticeMiddle")}
              <code>{defaultBranch}</code>
              {t("gitStatusBranchCreateDefaultBranchNoticeAfter")}
            </p>
          </div>
        ) : (
          <div className="git-branch-create-section">
            <div className="git-branch-create-label">
              {t("gitStatusBranchCreateBaseLabel")}
            </div>
            <div className="git-branch-create-options" role="radiogroup">
              {baseOptions.map((option) => {
                const selected = selectedBaseBranch === option.name;
                return (
                  <button
                    key={option.key}
                    type="button"
                    className={`git-branch-create-option ${
                      selected ? "is-selected" : ""
                    }`}
                    role="radio"
                    aria-checked={selected}
                    onClick={() => setSelectedBaseBranch(option.name)}
                  >
                    <span className="git-branch-create-option-radio" />
                    <span className="git-branch-create-option-body">
                      <span className="git-branch-create-option-title">
                        {option.title}
                      </span>
                      <span className="git-branch-create-option-description">
                        {option.description}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div className="git-branch-create-actions">
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {t("gitStatusBranchCancel")}
          </Button>
          <Button
            variant="primary"
            onClick={() => onConfirm(branchName.trim(), selectedBaseBranch)}
            disabled={busy || validationError !== null}
          >
            {busy
              ? t("gitStatusLoading")
              : t("gitStatusBranchCreateConfirm")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
