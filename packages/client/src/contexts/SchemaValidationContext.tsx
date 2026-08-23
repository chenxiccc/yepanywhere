import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ZodError } from "zod";
import {
  type SchemaValidationGap,
  SchemaValidationSummary,
} from "../components/SchemaValidationSummary";
import { useSchemaValidation } from "../hooks/useSchemaValidation";
import { useToastContext } from "./ToastContext";

interface SchemaValidationContextValue {
  /** Report a validation error for a tool. Shows toast if not ignored and not already shown. */
  reportValidationError: (toolName: string, errors: ZodError) => void;
  /** Check if a tool is in the ignored list */
  isToolIgnored: (toolName: string) => boolean;
  /** Add a tool to the ignored list */
  ignoreToolErrors: (toolName: string) => void;
  /** Clear all ignored tools */
  clearIgnoredTools: () => void;
  /** List of currently ignored tools */
  ignoredTools: string[];
  /** Whether schema validation is enabled */
  enabled: boolean;
}

const SchemaValidationContext =
  createContext<SchemaValidationContextValue | null>(null);

interface SchemaValidationProviderProps {
  children: ReactNode;
}

export function SchemaValidationProvider({
  children,
}: SchemaValidationProviderProps) {
  const { settings, setIgnoredTools } = useSchemaValidation();
  const { showToast } = useToastContext();
  const [validationGaps, setValidationGaps] = useState<SchemaValidationGap[]>(
    [],
  );
  const validationGapKeysRef = useRef<Set<string>>(new Set());

  // Track which tools have already shown an error toast this session
  // Using ref to avoid re-renders when updating the set
  const shownErrorsRef = useRef<Set<string>>(new Set());

  const isToolIgnored = useCallback(
    (toolName: string) => {
      return settings.ignoredTools.includes(toolName);
    },
    [settings.ignoredTools],
  );

  const ignoreToolErrors = useCallback(
    (toolName: string) => {
      if (!settings.ignoredTools.includes(toolName)) {
        setIgnoredTools([...settings.ignoredTools, toolName]);
      }
    },
    [settings.ignoredTools, setIgnoredTools],
  );

  const clearIgnoredTools = useCallback(() => {
    setIgnoredTools([]);
  }, [setIgnoredTools]);

  useEffect(() => {
    if (settings.enabled || validationGapKeysRef.current.size === 0) return;
    validationGapKeysRef.current.clear();
    setValidationGaps([]);
  }, [settings.enabled]);

  const reportValidationError = useCallback(
    (toolName: string, errors: ZodError) => {
      // Always log to console
      console.error(`Schema validation failed for ${toolName}:`, errors);

      // Don't show toast if validation is disabled
      if (!settings.enabled) return;

      const newGaps: SchemaValidationGap[] = [];
      for (const issue of errors.issues) {
        const path = issue.path.map(String).join(".") || "(root)";
        const missing =
          issue.code === "invalid_type" &&
          (issue.message.toLowerCase().includes("required") ||
            issue.message.toLowerCase().includes("received undefined"));
        const gap: SchemaValidationGap = {
          code: issue.code,
          kind: missing ? "missing" : "invalid",
          message: issue.message,
          path,
          toolName,
        };
        const key = `${toolName}\u0000${path}\u0000${issue.code}\u0000${issue.message}`;
        if (validationGapKeysRef.current.has(key)) continue;
        validationGapKeysRef.current.add(key);
        newGaps.push(gap);
      }
      if (newGaps.length > 0) {
        setValidationGaps((current) => [...current, ...newGaps]);
      }

      // Don't show toast if tool is ignored
      if (settings.ignoredTools.includes(toolName)) return;

      // Don't show toast if we already showed one for this tool this session
      if (shownErrorsRef.current.has(toolName)) return;

      // Mark as shown
      shownErrorsRef.current.add(toolName);

      // Show toast with ignore action
      showToast(`Schema validation failed for ${toolName}`, "error", {
        label: "Ignore",
        onClick: () => ignoreToolErrors(toolName),
      });
    },
    [settings.enabled, settings.ignoredTools, showToast, ignoreToolErrors],
  );

  const value = useMemo<SchemaValidationContextValue>(
    () => ({
      reportValidationError,
      isToolIgnored,
      ignoreToolErrors,
      clearIgnoredTools,
      ignoredTools: settings.ignoredTools,
      enabled: settings.enabled,
    }),
    [
      clearIgnoredTools,
      ignoreToolErrors,
      isToolIgnored,
      reportValidationError,
      settings.enabled,
      settings.ignoredTools,
    ],
  );

  return (
    <SchemaValidationContext.Provider value={value}>
      {children}
      {settings.enabled && validationGaps.length > 0 && (
        <SchemaValidationSummary
          gaps={validationGaps}
          ignoredTools={settings.ignoredTools}
        />
      )}
    </SchemaValidationContext.Provider>
  );
}

/**
 * Hook to access schema validation context.
 * Must be used within a SchemaValidationProvider.
 */
export function useSchemaValidationContext() {
  const context = useContext(SchemaValidationContext);
  if (!context) {
    throw new Error(
      "useSchemaValidationContext must be used within a SchemaValidationProvider",
    );
  }
  return context;
}
