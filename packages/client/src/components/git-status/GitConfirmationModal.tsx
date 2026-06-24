import type { ReactNode } from "react";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";

export function GitConfirmationModal({
  title,
  message,
  details,
  skipChecked,
  onSkipCheckedChange,
  skipLabel,
  cancelLabel,
  confirmLabel,
  busy,
  onClose,
  onConfirm,
}: {
  title: string;
  message: string;
  details?: ReactNode;
  skipChecked?: boolean;
  onSkipCheckedChange?: (checked: boolean) => void;
  skipLabel?: string;
  cancelLabel: string;
  confirmLabel: string;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal title={title} onClose={onClose} backCloses>
      <div className="git-undo-confirm">
        <div className="git-undo-confirm-body">
          <span className="git-undo-confirm-icon" aria-hidden="true">
            <svg
              width="28"
              height="28"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              focusable="false"
            >
              <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
              <path d="M12 9v4" />
              <path d="M12 17h.01" />
            </svg>
          </span>
          <div className="git-discard-confirm-copy">
            <p className="git-undo-confirm-message">{message}</p>
            {details}
            {skipLabel && onSkipCheckedChange ? (
              <label className="git-undo-confirm-checkbox">
                <input
                  type="checkbox"
                  checked={skipChecked ?? false}
                  onChange={(event) =>
                    onSkipCheckedChange(event.target.checked)
                  }
                />
                <span>{skipLabel}</span>
              </label>
            ) : null}
          </div>
        </div>
        <div className="git-undo-confirm-actions">
          <Button variant="secondary" onClick={onClose}>
            {cancelLabel}
          </Button>
          <Button variant="primary" onClick={onConfirm} disabled={busy}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </Modal>
  );
}