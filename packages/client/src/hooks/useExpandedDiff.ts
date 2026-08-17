import { useCallback, useState } from "react";
import { api } from "../api/client";
import type { PatchHunk } from "../components/renderers/tools/types";
import { useSessionMetadata } from "../contexts/SessionMetadataContext";
import {
  reconstructOriginalFile,
  resolveEditReplacement,
} from "../lib/editFullContext";

export type ExpandedDiffResult =
  | {
      kind: "diff";
      structuredPatch: PatchHunk[];
      diffHtml: string;
    }
  | {
      kind: "file";
      content: string;
    };

interface UseExpandedDiffOptions {
  filePath: string;
  oldString: string;
  newString: string;
  /** Complete file content from SDK Edit result when the provider supplies it. */
  originalFile?: string;
  structuredPatch?: PatchHunk[];
}

/**
 * Fetch an expanded edit view with full file context.
 *
 * Prefer the SDK `originalFile` snapshot when it is nonempty. Otherwise read
 * the current file and reconstruct a pre-edit snapshot when the replacement
 * can be uniquely located (exact or whitespace-insensitive). If it cannot,
 * return the current file so the viewer can drop diff markers.
 */
export function useExpandedDiff(options: UseExpandedDiffOptions) {
  const { projectId } = useSessionMetadata();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ExpandedDiffResult | null>(null);

  const fetchExpandedDiff = useCallback(async () => {
    setLoading(true);
    setError(null);
    const snapshot =
      typeof options.originalFile === "string" &&
      options.originalFile.length > 0
        ? options.originalFile
        : null;
    let currentFile: string | null = null;
    const replacement = resolveEditReplacement(
      options.oldString,
      options.newString,
      options.structuredPatch,
    ) ?? {
      oldString: options.oldString,
      newString: options.newString,
    };
    try {
      let data: {
        structuredPatch: PatchHunk[];
        diffHtml: string;
      };
      if (snapshot !== null) {
        data = await api.expandDiffContext(
          projectId,
          options.filePath,
          replacement.oldString,
          replacement.newString,
          snapshot,
        );
      } else {
        const file = await api.getFile(projectId, options.filePath);
        currentFile = file.content ?? "";
        const reconstructed = reconstructOriginalFile({
          currentFile,
          oldString: replacement.oldString,
          newString: replacement.newString,
          structuredPatch: options.structuredPatch,
        });
        if (reconstructed === null) {
          setResult({ kind: "file", content: currentFile });
          return;
        }
        // Diff the reconstructed pre-edit file against current contents.
        // Do not reuse an empty tool oldString — expand treats that as
        // insert-at-start rather than the located replacement.
        data = await api.expandDiffContext(
          projectId,
          options.filePath,
          reconstructed,
          currentFile,
          reconstructed,
        );
      }
      setResult({
        kind: "diff",
        structuredPatch: data.structuredPatch as PatchHunk[],
        diffHtml: data.diffHtml,
      });
    } catch (err) {
      if (currentFile !== null) {
        setResult({ kind: "file", content: currentFile });
        return;
      }
      setError(err instanceof Error ? err.message : "Failed to expand context");
    } finally {
      setLoading(false);
    }
  }, [
    options.filePath,
    options.newString,
    options.oldString,
    options.originalFile,
    options.structuredPatch,
    projectId,
  ]);

  return { loading, error, result, fetchExpandedDiff };
}
