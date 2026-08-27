import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";
import { ToastContainer } from "../components/Toast";
import {
  type Toast,
  type ToastAction,
  getToastDurationMs,
} from "../hooks/useToast";
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

export function ToastProvider({ children }: ToastProviderProps) {
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

export function useOptionalToastContext() {
  return useContext(ToastContext);
}
