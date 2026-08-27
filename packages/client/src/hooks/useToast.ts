import { useCallback, useState } from "react";
import { generateUUID } from "../lib/uuid";

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface Toast {
  id: string;
  message: string;
  type: "error" | "success" | "info";
  action?: ToastAction;
}

const TOAST_TIMEOUT_MS = 4500;
const ACTION_TOAST_TIMEOUT_MS = 7000;
const ERROR_TOAST_TIMEOUT_MS = 12_000;

export function getToastDurationMs(
  toast: Pick<Toast, "type" | "action">,
): number {
  if (toast.type === "error") return ERROR_TOAST_TIMEOUT_MS;
  return toast.action ? ACTION_TOAST_TIMEOUT_MS : TOAST_TIMEOUT_MS;
}

export function useToast() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const showToast = useCallback(
    (message: string, type: Toast["type"] = "info", action?: ToastAction) => {
      const id = generateUUID();
      setToasts((prev) => [...prev, { id, message, type, action }]);

      const timeout = getToastDurationMs({ type, action });
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, timeout);
    },
    [],
  );

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return { toasts, showToast, dismissToast };
}
