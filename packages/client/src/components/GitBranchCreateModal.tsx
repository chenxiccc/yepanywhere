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
        title: t("sourceManagerBranchCreateBaseDefaultTitle", {
          branch: defaultBranch,
        }),
        description: t("sourceManagerBranchCreateBaseDefaultHelp"),
      },
    ];

    if (currentBranch !== defaultBranch) {
      options.push({
        key: currentBranch,
        name: currentBranch,
        title: t("sourceManagerBranchCreateBaseCurrentTitle", {
          branch: currentBranch,
        }),
        description: t("sourceManagerBranchCreateBaseCurrentHelp"),
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
      ? t("sourceManagerBranchCreateNameRequired")
      : normalizedName.startsWith("origin/")
        ? t("sourceManagerBranchCreateNameInvalid")
        : branchExists
          ? t("sourceManagerBranchCreateNameExists", {
              branch: branchName.trim(),
            })
          : null;

  return (
    <Modal title={t("sourceManagerBranchCreateDialogTitle")} onClose={onClose} backCloses>
      <div className="git-branch-create-modal">
        <div className="git-branch-create-section">
          <label
            className="git-branch-create-label"
            htmlFor="git-branch-create-name"
          >
            {t("sourceManagerBranchCreateNameLabel")}
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
              {t("sourceManagerBranchCreateHelp")}
            </p>
          )}
        </div>

        {isOnDefaultBranch ? (
          <div className="git-branch-create-section">
            <p className="git-branch-create-default-copy">
              {t("sourceManagerBranchCreateDefaultBranchNoticeBefore")}
              <code>{currentBranch}</code>
              {t("sourceManagerBranchCreateDefaultBranchNoticeMiddle")}
              <code>{defaultBranch}</code>
              {t("sourceManagerBranchCreateDefaultBranchNoticeAfter")}
            </p>
          </div>
        ) : (
          <div className="git-branch-create-section">
            <div className="git-branch-create-label">
              {t("sourceManagerBranchCreateBaseLabel")}
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
            {t("sourceManagerBranchCancel")}
          </Button>
          <Button
            variant="primary"
            onClick={() => onConfirm(branchName.trim(), selectedBaseBranch)}
            disabled={busy || validationError !== null}
          >
            {busy
              ? t("gitStatusLoading")
              : t("sourceManagerBranchCreateConfirm")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
