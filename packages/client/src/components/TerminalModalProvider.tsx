/**
 * TerminalModalProvider — 通过 Context 注入终端弹窗，避免修改 SessionPage。
 * TerminalModalProvider — injects terminal modal via Context to avoid modifying SessionPage.
 *
 * 弹窗作为 children 的兄弟节点渲染（不用 portal），确保在 I18nProvider 的 context 范围内。
 * The modal renders as a sibling of children (no portal) to stay within I18nProvider context.
 */
import { createContext, useCallback, useContext, useState } from "react";
import { SessionTerminalModal } from "./SessionTerminalModal";

interface TerminalModalState {
  projectId: string;
  projectPath: string;
}

interface TerminalModalContextValue {
  /** 打开终端弹窗 / Open terminal modal */
  openTerminal: (projectId: string, projectPath: string) => void;
}

const TerminalModalContext = createContext<TerminalModalContextValue | null>(
  null,
);

/**
 * Hook to access terminal modal controls from any component inside the provider.
 * Returns a no-op when used outside the provider (safe for tests and server-side rendering).
 * 从 provider 内的任何组件访问终端弹窗控制。
 * 在 provider 外部使用时返回空操作（对测试和服务端渲染安全）。
 */
export function useTerminalModal(): TerminalModalContextValue {
  const ctx = useContext(TerminalModalContext);
  if (!ctx) {
    return { openTerminal: () => {} };
  }
  return ctx;
}

export function TerminalModalProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [state, setState] = useState<TerminalModalState | null>(null);

  const openTerminal = useCallback(
    (projectId: string, projectPath: string) => {
      setState({ projectId, projectPath });
    },
    [],
  );

  return (
    <TerminalModalContext.Provider value={{ openTerminal }}>
      {children}
      {state && (
        <SessionTerminalModal
          projectId={state.projectId}
          projectPath={state.projectPath}
          onClose={() => setState(null)}
        />
      )}
    </TerminalModalContext.Provider>
  );
}