import type { CSSProperties } from "react";
import type { Toast as ToastType } from "../hooks/useToast";
import styles from "./Toast.module.css";

interface Props {
  toasts: ToastType[];
  onDismiss: (id: string) => void;
}

export function ToastContainer({ toasts, onDismiss }: Props) {
  if (toasts.length === 0) return null;

  return (
    <div className={styles.container}>
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`${styles.toast} ${styles[toast.type]}`}
          style={
            {
              "--toast-fade-duration": toast.action ? "7s" : "4.5s",
            } as CSSProperties
          }
          onClick={() => onDismiss(toast.id)}
          onKeyDown={(e) => e.key === "Enter" && onDismiss(toast.id)}
          role="alert"
        >
          <span className={styles.message}>{toast.message}</span>
          {toast.action && (
            <button
              type="button"
              className={styles.action}
              onClick={(e) => {
                e.stopPropagation();
                toast.action?.onClick();
                onDismiss(toast.id);
              }}
            >
              {toast.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
