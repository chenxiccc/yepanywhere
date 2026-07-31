import type {
  GitIntegrationOptionsResult,
  GitPullResult,
  GitPushResult,
  GitRemoteCheckResult,
  GitStatusInfo,
} from "@yep-anywhere/shared";
import { useCallback, useEffect, useState } from "react";
import { api } from "../api/client";
import {
  invalidateRouteRetention,
  type RouteRetentionKeyInput,
} from "../lib/routeRetention";
import type { TranslationFn } from "../i18n";

/**
 * Remote git actions for the source-control surface (check-remote / pull /
 * push) plus the integration-options probe that follows a diverged result.
 * Owns per-action feedback for the initiating buttons and the persistent
 * visible result panel (topic: source-review-to-session). Extracted from
 * GitStatusPage so the page keeps composition only.
 */
export function useGitActions({
  projectId,
  status,
  routeRetentionKey,
  supportsRemoteCheck,
  supportsPull,
  supportsPush,
  supportsIntegrationOptions,
  onRefreshStatus,
  t,
}: {
  projectId: string | undefined;
  status: GitStatusInfo | null | undefined;
  routeRetentionKey: RouteRetentionKeyInput | null;
  supportsRemoteCheck: boolean;
  supportsPull: boolean;
  supportsPush: boolean;
  supportsIntegrationOptions: boolean;
  onRefreshStatus: () => Promise<void>;
  t: TranslationFn;
}) {
  const [remoteCheckResult, setRemoteCheckResult] =
    useState<GitRemoteCheckResult | null>(null);
  const [isCheckingRemote, setIsCheckingRemote] = useState(false);
  const [remoteCheckError, setRemoteCheckError] = useState<string | null>(null);
  const [pullResult, setPullResult] = useState<GitPullResult | null>(null);
  const [isPulling, setIsPulling] = useState(false);
  const [pullError, setPullError] = useState<string | null>(null);
  const [pushResult, setPushResult] = useState<GitPushResult | null>(null);
  const [isPushing, setIsPushing] = useState(false);
  const [pushError, setPushError] = useState<string | null>(null);
  const [integrationOptions, setIntegrationOptions] =
    useState<GitIntegrationOptionsResult | null>(null);
  const [isLoadingIntegrationOptions, setIsLoadingIntegrationOptions] =
    useState(false);
  const [integrationOptionsError, setIntegrationOptionsError] = useState<
    string | null
  >(null);

  useEffect(() => {
    void projectId;
    setRemoteCheckResult(null);
    setRemoteCheckError(null);
    setIsCheckingRemote(false);
    setPullResult(null);
    setPullError(null);
    setIsPulling(false);
    setPushResult(null);
    setPushError(null);
    setIsPushing(false);
    setIntegrationOptions(null);
    setIntegrationOptionsError(null);
    setIsLoadingIntegrationOptions(false);
  }, [projectId]);

  const isRunning = isCheckingRemote || isPulling || isPushing;
  const divergedActionStatus = getDivergedActionStatus(pullResult, pushResult);
  const divergedActionKey = divergedActionStatus
    ? `${divergedActionStatus.ahead}:${divergedActionStatus.behind}:${divergedActionStatus.upstream ?? ""}`
    : "";

  useEffect(() => {
    if (!projectId || !supportsIntegrationOptions || !divergedActionKey) {
      setIntegrationOptions(null);
      setIntegrationOptionsError(null);
      setIsLoadingIntegrationOptions(false);
      return;
    }

    let cancelled = false;
    setIsLoadingIntegrationOptions(true);
    setIntegrationOptions(null);
    setIntegrationOptionsError(null);
    api
      .getGitIntegrationOptions(projectId)
      .then((result) => {
        if (!cancelled) setIntegrationOptions(result);
      })
      .catch((err) => {
        if (!cancelled) {
          setIntegrationOptionsError(
            err instanceof Error
              ? err.message
              : t("gitStatusAutoOptionsFailed"),
          );
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoadingIntegrationOptions(false);
      });
    return () => {
      cancelled = true;
    };
  }, [divergedActionKey, projectId, supportsIntegrationOptions, t]);

  const handleCheckRemote = useCallback(async () => {
    if (!projectId || !supportsRemoteCheck || isRunning) return;
    setIsCheckingRemote(true);
    setRemoteCheckResult(null);
    setRemoteCheckError(null);
    setPullResult(null);
    setPullError(null);
    setPushResult(null);
    setPushError(null);
    setIntegrationOptions(null);
    setIntegrationOptionsError(null);
    try {
      const result = await api.checkGitRemote(projectId);
      setRemoteCheckResult(result);
      if (result.status === "checked") await onRefreshStatus();
    } catch (err) {
      setRemoteCheckError(
        err instanceof Error ? err.message : t("gitStatusRemoteCheckFailed"),
      );
    } finally {
      setIsCheckingRemote(false);
    }
  }, [isRunning, onRefreshStatus, projectId, supportsRemoteCheck, t]);

  const handlePull = useCallback(async () => {
    if (!projectId || !supportsPull || isRunning) return;
    setIsPulling(true);
    setPullResult(null);
    setPullError(null);
    setRemoteCheckResult(null);
    setRemoteCheckError(null);
    setPushResult(null);
    setPushError(null);
    setIntegrationOptions(null);
    setIntegrationOptionsError(null);
    try {
      const result = await api.pullGit(projectId);
      setPullResult(result);
      if (result.status === "pulled") {
        if (routeRetentionKey) invalidateRouteRetention(routeRetentionKey);
        await onRefreshStatus();
      }
    } catch (err) {
      setPullError(
        err instanceof Error ? err.message : t("gitStatusPullFailed"),
      );
    } finally {
      setIsPulling(false);
    }
  }, [
    isRunning,
    onRefreshStatus,
    projectId,
    routeRetentionKey,
    supportsPull,
    t,
  ]);

  const handlePush = useCallback(async () => {
    if (!projectId || !supportsPush || isRunning) return;
    setIsPushing(true);
    setPushResult(null);
    setPushError(null);
    setRemoteCheckResult(null);
    setRemoteCheckError(null);
    setPullResult(null);
    setPullError(null);
    setIntegrationOptions(null);
    setIntegrationOptionsError(null);
    try {
      const result = await api.pushGit(projectId);
      setPushResult(result);
      if (
        result.status === "pushed" ||
        result.status === "published" ||
        result.status === "up-to-date"
      ) {
        if (routeRetentionKey) invalidateRouteRetention(routeRetentionKey);
        await onRefreshStatus();
      }
    } catch (err) {
      setPushError(
        err instanceof Error ? err.message : t("gitStatusPushFailed"),
      );
    } finally {
      setIsPushing(false);
    }
  }, [
    isRunning,
    onRefreshStatus,
    projectId,
    routeRetentionKey,
    supportsPush,
    t,
  ]);

  const checkFeedback =
    remoteCheckError ?? getRemoteCheckMessage(remoteCheckResult, t);
  const checkFeedbackTone =
    remoteCheckError || (remoteCheckResult?.status ?? "checked") !== "checked"
      ? ("warning" as const)
      : remoteCheckResult || status?.checkedRemoteAt
        ? ("success" as const)
        : null;
  const pullFeedback = pullError ?? getPullMessage(pullResult, t);
  const pullFeedbackTone =
    pullError || (pullResult && pullResult.status !== "pulled")
      ? ("warning" as const)
      : pullResult
        ? ("success" as const)
        : null;
  const pushFeedback = pushError ?? getPushMessage(pushResult, t);
  const pushFeedbackTone =
    pushError ||
    (pushResult &&
      !["pushed", "published", "up-to-date"].includes(pushResult.status))
      ? ("warning" as const)
      : pushResult
        ? ("success" as const)
        : null;
  const actionFeedback = checkFeedback || pullFeedback || pushFeedback;
  const actionFeedbackTone = checkFeedback
    ? checkFeedbackTone
    : pullFeedback
      ? pullFeedbackTone
      : pushFeedback
        ? pushFeedbackTone
        : null;

  return {
    supportsRemoteCheck,
    supportsPull,
    supportsPush,
    supportsIntegrationOptions,
    isRunning,
    isCheckingRemote,
    isPulling,
    isPushing,
    handleCheckRemote,
    handlePull,
    handlePush,
    checkedRemoteAt:
      pushResult?.checkedRemoteAt ??
      pullResult?.checkedRemoteAt ??
      remoteCheckResult?.checkedRemoteAt ??
      status?.checkedRemoteAt ??
      null,
    checkFeedback,
    checkFeedbackTone,
    pullFeedback,
    pullFeedbackTone,
    pushFeedback,
    pushFeedbackTone,
    actionFeedback,
    actionFeedbackTone,
    divergedActionStatus,
    integrationOptions,
    isLoadingIntegrationOptions,
    integrationOptionsError,
  };
}

export type GitActionState = ReturnType<typeof useGitActions>;

export function formatRemoteCheckTime(
  value: string | null,
  nowMs: number,
  t: TranslationFn,
): string {
  if (!value) {
    return t("gitStatusRemoteUnknown");
  }

  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return value;
  }

  const elapsedMs = Math.max(0, nowMs - timestamp);
  const minuteMs = 60 * 1000;
  const hourMs = 60 * minuteMs;
  const dayMs = 24 * hourMs;

  if (elapsedMs < minuteMs) {
    return t("gitStatusRemoteJustNow");
  }
  if (elapsedMs < hourMs) {
    return t("gitStatusRemoteMinutesAgo", {
      count: Math.floor(elapsedMs / minuteMs),
    });
  }
  if (elapsedMs < dayMs) {
    return t("gitStatusRemoteHoursAgo", {
      count: Math.floor(elapsedMs / hourMs),
    });
  }
  return new Date(timestamp).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function getRemoteCheckMessage(
  result: GitRemoteCheckResult | null,
  t: TranslationFn,
): string {
  switch (result?.status) {
    case "checked":
      return t("gitStatusRemoteCheckSuccess");
    case "busy":
      return t("gitStatusRemoteCheckBusy");
    case "not-a-git-repo":
      return t("gitStatusRemoteCheckNotRepo");
    case "failed":
      return t("gitStatusRemoteCheckFailed");
    default:
      return "";
  }
}

function getPullMessage(
  result: GitPullResult | null,
  t: TranslationFn,
): string {
  switch (result?.status) {
    case "pulled":
      if (isCommitCount(result.commitsAdvanced)) {
        if (result.commitsAdvanced === 0) {
          return t("gitStatusPullAlreadyUpToDate");
        }
        return t(
          result.commitsAdvanced === 1
            ? "gitStatusPullSuccessSingle"
            : "gitStatusPullSuccessMultiple",
          { count: result.commitsAdvanced },
        );
      }
      return t("gitStatusPullSuccess");
    case "busy":
      return t("gitStatusPullBusy");
    case "not-a-git-repo":
      return t("gitStatusPullNotRepo");
    case "failed":
      if (isDivergedStatus(result.gitStatus)) {
        return t("gitStatusPullDiverged", {
          ahead: result.gitStatus.ahead,
          behind: result.gitStatus.behind,
        });
      }
      return t("gitStatusPullFailed");
    default:
      return "";
  }
}

function getPushMessage(
  result: GitPushResult | null,
  t: TranslationFn,
): string {
  switch (result?.status) {
    case "pushed":
      if (isCommitCount(result.commitsAdvanced)) {
        return t(
          result.commitsAdvanced === 1
            ? "gitStatusPushSuccessSingle"
            : "gitStatusPushSuccessMultiple",
          { count: result.commitsAdvanced },
        );
      }
      return t("gitStatusPushSuccess");
    case "published":
      return t("gitStatusPushPublished");
    case "up-to-date":
      return t("gitStatusPushAlreadyUpToDate");
    case "busy":
      return t("gitStatusPushBusy");
    case "no-upstream":
      return t("gitStatusPushNoUpstream");
    case "rejected":
      if (isDivergedStatus(result.gitStatus)) {
        return t("gitStatusPushDiverged", {
          ahead: result.gitStatus.ahead,
          behind: result.gitStatus.behind,
        });
      }
      return t("gitStatusPushRejected");
    case "not-a-git-repo":
      return t("gitStatusPushNotRepo");
    case "failed":
      return t("gitStatusPushFailed");
    default:
      return "";
  }
}

function isCommitCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isDivergedStatus(
  status: GitPullResult["gitStatus"] | GitPushResult["gitStatus"],
): status is GitStatusInfo {
  return Boolean(status && status.ahead > 0 && status.behind > 0);
}

function getDivergedActionStatus(
  pullResult: GitPullResult | null,
  pushResult: GitPushResult | null,
): GitStatusInfo | null {
  if (
    pullResult?.status === "failed" &&
    isDivergedStatus(pullResult.gitStatus)
  ) {
    return pullResult.gitStatus;
  }
  if (
    pushResult?.status === "rejected" &&
    isDivergedStatus(pushResult.gitStatus)
  ) {
    return pushResult.gitStatus;
  }
  return null;
}
