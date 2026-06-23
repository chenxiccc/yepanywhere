import type { BranchInfo, CheckoutResult } from "@yep-anywhere/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client";

/**
 * 分支数据 Hook，管理分支列表、切换、创建
 * Branch data hook — manages branch list, checkout, and creation.
 *
 * 不轮询（分支列表变化不频繁，仅在页面加载和操作后刷新）
 * No polling — branch lists change infrequently; refresh only on load and after operations.
 */
export function useBranches(projectId: string | undefined) {
  const [branches, setBranches] = useState<BranchInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const projectIdRef = useRef(projectId);

  const refresh = useCallback(async () => {
    if (!projectId) return;
    try {
      const data = await api.getBranches(projectId);
      setBranches(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  // 初始化加载 / Initial load
  useEffect(() => {
    if (projectIdRef.current !== projectId) {
      setLoading(true);
      setBranches(null);
      setError(null);
      projectIdRef.current = projectId;
    }
    refresh();
  }, [refresh, projectId]);

  const checkout = useCallback(
    async (branch: string): Promise<CheckoutResult> => {
      if (!projectId) throw new Error("No project selected");
      const result = await api.checkoutBranch(projectId, branch);
      if (result.success) {
        await refresh();
      }
      return result;
    },
    [projectId, refresh],
  );

  const createBranch = useCallback(
    async (branch: string): Promise<CheckoutResult> => {
      if (!projectId) throw new Error("No project selected");
      const result = await api.createBranch(projectId, branch);
      if (result.success) {
        await refresh();
      }
      return result;
    },
    [projectId, refresh],
  );

  const currentBranch = branches?.isGitRepo ? branches.current : null;

  return { branches, currentBranch, loading, error, refresh, checkout, createBranch };
}