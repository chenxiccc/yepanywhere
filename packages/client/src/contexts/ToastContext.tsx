import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";
import { ToastContainer } from "../components/Toast";
import type { Toast, ToastAction } from "../hooks/useToast";
import { generateUUID } from "../lib/uuid";

interface ToastContextValue {
  showToast: (
    message: string,
    type?: Toast["type"],
    action?: ToastAction,
  ) => void;
  dismissToast: (id: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

interface ToastProviderProps {
  children: ReactNode;
}

// Keep in sync with the --toast-fade-duration values and animation fallback
// owned by Toast.tsx / Toast.module.css.
const TOAST_TIMEOUT_MS = 4500;
const ACTION_TOAST_TIMEOUT_MS = 7000;

export function ToastProvider({ children }: ToastProviderProps) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const showToast = useCallback(
    (message: string, type: Toast["type"] = "info", action?: ToastAction) => {
      const id = generateUUID();
      setToasts((prev) => [...prev, { id, message, type, action }]);

      // Action toasts stay readable long enough to use the action.
      const timeout = action ? ACTION_TOAST_TIMEOUT_MS : TOAST_TIMEOUT_MS;
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, timeout);
    },
    [],
  );

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const value = useMemo<ToastContextValue>(
    () => ({ showToast, dismissToast }),
    [dismissToast, showToast],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </ToastContext.Provider>
  );
}

/**
 * Hook to access toast functionality from any component.
 * Must be used within a ToastProvider.
 */
export function useToastContext() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error("useToastContext must be used within a ToastProvider");
  }
  return context;
}
