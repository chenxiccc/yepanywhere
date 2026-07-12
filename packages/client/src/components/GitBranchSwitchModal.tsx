import { useI18n } from "../i18n";
import { Button } from "./ui/Button";
import { Modal } from "./ui/Modal";

interface GitBranchSwitchModalProps {
  currentBranch: string;
  targetBranch: string;
  mode: "stash" | "carry";
  busy: boolean;
  onModeChange: (mode: "stash" | "carry") => void;
  onClose: () => void;
  onConfirm: () => void;
}

export function GitBranchSwitchModal({
  currentBranch,
  targetBranch,
  mode,
  busy,
  onModeChange,
  onClose,
  onConfirm,
}: GitBranchSwitchModalProps) {
  const { t } = useI18n();

  return (
    <Modal title={t("sourceManagerBranchSwitchDialogTitle")} onClose={onClose} backCloses>
      <div className="git-branch-switch-modal">
        <p className="git-branch-switch-copy">
          {t("sourceManagerBranchSwitchPrompt", {
            currentBranch,
            targetBranch,
          })}
        </p>
        <div
          className="git-branch-switch-options"
          role="radiogroup"
          aria-label={t("sourceManagerBranchSwitchDialogTitle")}
        >
          <button
            type="button"
            className={`git-branch-switch-option ${mode === "stash" ? "is-selected" : ""}`}
            role="radio"
            aria-checked={mode === "stash"}
            onClick={() => onModeChange("stash")}
          >
            <span className="git-branch-switch-option-radio" />
            <span className="git-branch-switch-option-body">
              <span className="git-branch-switch-option-title">
                {t("sourceManagerBranchKeepCurrentDetailed", {
                  currentBranch,
                })}
              </span>
              <span className="git-branch-switch-option-description">
                {t("sourceManagerBranchKeepCurrentHelp")}
              </span>
            </span>
          </button>
          <button
            type="button"
            className={`git-branch-switch-option ${mode === "carry" ? "is-selected" : ""}`}
            role="radio"
            aria-checked={mode === "carry"}
            onClick={() => onModeChange("carry")}
          >
            <span className="git-branch-switch-option-radio" />
            <span className="git-branch-switch-option-body">
              <span className="git-branch-switch-option-title">
                {t("sourceManagerBranchBringToTargetDetailed", {
                  targetBranch,
                })}
              </span>
              <span className="git-branch-switch-option-description">
                {t("sourceManagerBranchBringToTargetHelp")}
              </span>
            </span>
          </button>
        </div>
        <div className="git-branch-switch-actions">
          <Button
            variant="secondary"
            className="git-branch-switch-cancel"
            onClick={onClose}
            disabled={busy}
          >
            {t("sourceManagerBranchCancel")}
          </Button>
          <Button
            variant="primary"
            className="git-branch-switch-confirm"
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? t("gitStatusLoading") : t("sourceManagerBranchConfirm")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
