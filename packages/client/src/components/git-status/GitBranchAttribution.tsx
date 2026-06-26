// 归属标注：查看分支 ≠ 当前 checkout 分支时，在 files/changes tab 顶部提示
// Attribution banner: shown at top of files/changes tabs when viewing branch != checked-out branch
import { useI18n } from "../../i18n";

type Translate = (
  key: string,
  vars?: Record<string, string | number>,
) => string;

/**
 * 当查看的分支与当前已 checkout 分支不一致时，显示一行归属提示。
 * Shows an attribution line when the viewed branch differs from the checked-out branch.
 */
export function GitBranchAttribution({
  currentBranch,
  viewingBranch,
  variant,
}: {
  /** 当前已 checkout 分支 / Currently checked-out branch */
  currentBranch: string | null;
  /** 当前查看的分支 / Currently viewed branch */
  viewingBranch: string | null;
  /** 标注对象：文件树或变更 / What the attribution describes: files or changes */
  variant: "files" | "changes";
}) {
  const { t } = useI18n();
  // 仅当查看分支非空且不同于当前分支时显示 / Only show when viewing != current
  if (!viewingBranch || !currentBranch || viewingBranch === currentBranch) {
    return null;
  }

  const key =
    variant === "files"
      ? "gitStatusAttributionFiles"
      : "gitStatusAttributionChanges";

  return (
    <div className="git-branch-attribution" role="note">
      {t(key, { current: currentBranch, viewing: viewingBranch })}
    </div>
  );
}
