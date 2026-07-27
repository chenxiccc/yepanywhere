import type {
  EffortLevel,
  ProviderName,
  ThinkingConfig,
} from "@yep-anywhere/shared";
import { type ReactNode, createContext, useContext, useMemo } from "react";

/**
 * Minimal session metadata for components that need project/session info.
 * Keep this focused - only add fields that are truly needed across the component tree.
 */
interface SessionMetadata {
  projectId: string;
  projectPath: string | null;
  sessionId: string;
  sessionTitle?: string;
  provider?: ProviderName;
  model?: string;
  thinking?: ThinkingConfig;
  effort?: EffortLevel;
}

const SessionMetadataContext = createContext<SessionMetadata | null>(null);

export function SessionMetadataProvider({
  projectId,
  projectPath,
  sessionId,
  sessionTitle,
  provider,
  model,
  thinking,
  effort,
  children,
}: SessionMetadata & { children: ReactNode }) {
  const value = useMemo<SessionMetadata>(
    () => ({
      projectId,
      projectPath,
      sessionId,
      sessionTitle,
      provider,
      model,
      thinking,
      effort,
    }),
    [
      projectId,
      projectPath,
      sessionId,
      sessionTitle,
      provider,
      model,
      thinking,
      effort,
    ],
  );

  return (
    <SessionMetadataContext.Provider value={value}>
      {children}
    </SessionMetadataContext.Provider>
  );
}

/**
 * Get session metadata. Throws if used outside SessionMetadataProvider.
 */
export function useSessionMetadata(): SessionMetadata {
  const context = useContext(SessionMetadataContext);
  if (!context) {
    throw new Error(
      "useSessionMetadata must be used within SessionMetadataProvider",
    );
  }
  return context;
}

export function useOptionalSessionMetadata(): SessionMetadata | null {
  return useContext(SessionMetadataContext);
}
