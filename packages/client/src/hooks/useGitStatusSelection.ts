import type { GitFileChange, SourceManagerStatusInfo } from "@yep-anywhere/shared";
import { useCallback, useEffect, useMemo, useState } from "react";
import { fileKey } from "../components/git-status/utils";

const gitCommitSelectionKey = (projectId: string) =>
  `yep-anywhere-git-commit-selection-${projectId}`;

export function useGitStatusSelection(
  projectId: string,
  files: SourceManagerStatusInfo["files"],
  isNarrowScreen: boolean,
) {
  const [selectedFile, setSelectedFile] = useState<GitFileChange | null>(null);
  const [previewModalFile, setPreviewModalFile] =
    useState<GitFileChange | null>(null);
  const [excludedCommitFileKeys, setExcludedCommitFileKeys] = useState<
    Set<string>
  >(new Set());

  useEffect(() => {
    if (files.length === 0) {
      setSelectedFile(null);
      setPreviewModalFile(null);
      return;
    }

    const existing = selectedFile
      ? files.find((file) => fileKey(file) === fileKey(selectedFile))
      : null;

    if (existing) {
      setSelectedFile(existing);
      return;
    }

    setSelectedFile(files[0] ?? null);
  }, [files, selectedFile]);

  useEffect(() => {
    if (!previewModalFile) return;

    const existing = files.find(
      (file) => fileKey(file) === fileKey(previewModalFile),
    );
    setPreviewModalFile(existing ?? null);
  }, [files, previewModalFile]);

  useEffect(() => {
    const currentFileKeys = new Set(files.map((file) => fileKey(file)));
    setExcludedCommitFileKeys((prev) => {
      const next = new Set(
        Array.from(prev).filter((key) => currentFileKeys.has(key)),
      );
      return next.size === prev.size ? prev : next;
    });
  }, [files]);

  useEffect(() => {
    if (
      typeof localStorage === "undefined" ||
      typeof localStorage.getItem !== "function"
    ) {
      return;
    }

    try {
      const stored = localStorage.getItem(gitCommitSelectionKey(projectId));
      if (!stored) {
        setExcludedCommitFileKeys(new Set());
        return;
      }

      const excludedKeys = JSON.parse(stored);
      if (!Array.isArray(excludedKeys)) return;
      const currentFileKeys = new Set(files.map((file) => fileKey(file)));
      setExcludedCommitFileKeys(
        new Set(
          excludedKeys.filter(
            (key): key is string =>
              typeof key === "string" && currentFileKeys.has(key),
          ),
        ),
      );
    } catch {
      setExcludedCommitFileKeys(new Set());
    }
  }, [files, projectId]);

  useEffect(() => {
    if (
      typeof localStorage === "undefined" ||
      typeof localStorage.setItem !== "function"
    ) {
      return;
    }

    localStorage.setItem(
      gitCommitSelectionKey(projectId),
      JSON.stringify([...excludedCommitFileKeys]),
    );
  }, [excludedCommitFileKeys, projectId]);

  const handleCommitFileToggle = useCallback((file: GitFileChange) => {
    const key = fileKey(file);
    setExcludedCommitFileKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  const handleCommitFilesSelection = useCallback(
    (targetFiles: GitFileChange[], selected: boolean) => {
      const fileKeys = targetFiles.map((file) => fileKey(file));
      setExcludedCommitFileKeys((prev) => {
        const next = new Set(prev);
        for (const key of fileKeys) {
          if (selected) {
            next.delete(key);
          } else {
            next.add(key);
          }
        }
        return next;
      });
    },
    [],
  );

  const handleFileClick = useCallback(
    (file: GitFileChange) => {
      setSelectedFile(file);
      if (isNarrowScreen) {
        setPreviewModalFile(file);
      }
    },
    [isNarrowScreen],
  );

  const selectedCommitFiles = useMemo(
    () => files.filter((file) => !excludedCommitFileKeys.has(fileKey(file))),
    [excludedCommitFileKeys, files],
  );

  return {
    excludedCommitFileKeys,
    handleCommitFileToggle,
    handleCommitFilesSelection,
    handleFileClick,
    previewModalFile,
    selectedCommitFiles,
    selectedFile,
    setPreviewModalFile,
  };
}
