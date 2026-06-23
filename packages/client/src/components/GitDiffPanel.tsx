import type { GitFileChange } from "@yep-anywhere/shared";
import { useGitDiff } from "../hooks/useGitDiff";
import { GitDiffContent } from "./GitDiffContent";

interface GitDiffPanelProps {
  projectId: string;
  file: GitFileChange;
}

/**
 * Git Diff 面板，用于分栏右侧显示（无 Modal 壳）
 * Git Diff panel for split-view right side (no Modal wrapper).
 *
 * 使用共享的 useGitDiff hook + GitDiffContent 渲染组件
 * Uses shared useGitDiff hook + GitDiffContent render component.
 */
export function GitDiffPanel({ projectId, file }: GitDiffPanelProps) {
  const diffState = useGitDiff({ projectId, file });

  return (
    <div className="git-diff-panel">
      <GitDiffContent
        file={file}
        projectId={projectId}
        {...diffState}
      />
    </div>
  );
}