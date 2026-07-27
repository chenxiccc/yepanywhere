import type {
  ProjectQueueDispatchState,
  ProjectQueueItemSummary,
  ProjectQueueMessage,
  ProjectQueueProjectStatus,
  ProjectQueueRecoveredSessionQueueSummary,
} from "@yep-anywhere/shared";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useI18n } from "../i18n";
import type { Project } from "../types";

type Translate = ReturnType<typeof useI18n>["t"];

interface ProjectQueueSectionProps {
  projects: Project[];
  items: readonly ProjectQueueItemSummary[];
  recoveredSessionQueues?: ProjectQueueRecoveredSessionQueueSummary[];
  loading: boolean;
  error: Error | null;
  mutatingItemId: string | null;
  mutatingDispatchState: boolean;
  mutatingPromoteItemId: string | null;
  dispatchState: ProjectQueueDispatchState;
  projectStatusesByProject?: Record<string, ProjectQueueProjectStatus>;
  highlightedItemId?: string | null;
  basePath?: string;
  onPauseDispatch: () => void;
  onResumeDispatch: () => void;
  onPromoteNow: (
    projectId: string,
    itemId: string,
    options?: { force?: boolean },
  ) => void;
  onDeleteItem: (projectId: string, itemId: string) => void;
  onRetryItem: (projectId: string, itemId: string) => void;
  onMoveItemToTop: (projectId: string, itemId: string) => void;
  onUpdateItem: (
    projectId: string,
    itemId: string,
    message: ProjectQueueMessage,
  ) => Promise<void> | void;
}

function formatRelativeTime(timestamp: string, t: Translate): string {
  const then = new Date(timestamp).getTime();
  if (!Number.isFinite(then)) return "";
  const diffMs = Math.max(0, Date.now() - then);
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return t("projectQueueAgeJustNow");
  if (diffMins < 60) return t("projectQueueAgeMinutes", { count: diffMins });
  if (diffHours < 24) return t("projectQueueAgeHours", { count: diffHours });
  if (diffDays < 7) return t("projectQueueAgeDays", { count: diffDays });
  return new Date(timestamp).toLocaleDateString();
}

function targetLabel(item: ProjectQueueItemSummary, t: Translate): string {
  const targetTitle = item.targetTitle?.trim();
  if (targetTitle) return targetTitle;
  return item.target.type === "new-session"
    ? t("projectQueueTargetNewSession")
    : t("projectQueueTargetSession", {
        sessionId: item.target.sessionId.slice(0, 8),
      });
}

function statusLabel(
  status: ProjectQueueItemSummary["status"],
  t: Translate,
): string {
  switch (status) {
    case "dispatching":
      return t("projectQueueStatusDispatching");
    case "failed":
      return t("projectQueueStatusFailed");
    case "queued":
      return t("projectQueueStatusQueued");
  }
}

function formatDurationSeconds(ms: number, t: Translate): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return t("projectQueueReadinessSeconds", { seconds });
}

function shortSessionId(sessionId: string): string {
  return sessionId.slice(0, 8);
}

function formatProjectQueueBlocker(blocker: string, t: Translate): string {
  if (blocker === "worker-queue") return t("projectQueueBlockerWorkerQueue");
  if (blocker === "project-queue:first-failed") {
    return t("projectQueueBlockerFirstFailed");
  }
  if (blocker.startsWith("recovered-session-queue:")) {
    const count = blocker.split(":")[1] ?? "?";
    return t("projectQueueBlockerRecoveredSessionQueue", { count });
  }

  const [sessionId, reason] = blocker.split(":");
  const session = shortSessionId(sessionId ?? "");
  switch (reason) {
    case "in-turn":
      return t("projectQueueBlockerInTurn", { session });
    case "waiting-input":
      return t("projectQueueBlockerWaitingInput", { session });
    case "provider-retained":
      return t("projectQueueBlockerProviderRetained", { session });
    case "direct-queue":
      return t("projectQueueBlockerDirectQueue", { session });
    case "deferred-queue":
      return t("projectQueueBlockerDeferredQueue", { session });
    case "pending-input":
      return t("projectQueueBlockerPendingInput", { session });
    case "external":
      return t("projectQueueBlockerExternal", { session });
    default:
      if (reason?.startsWith("liveness-")) {
        return t("projectQueueBlockerLiveness", {
          session,
          status: reason.slice("liveness-".length),
        });
      }
      return t("projectQueueBlockerUnknown", { blocker });
  }
}

function summarizeBlockers(blockers: readonly string[], t: Translate): string {
  const formatted = blockers
    .slice(0, 3)
    .map((blocker) => formatProjectQueueBlocker(blocker, t));
  if (blockers.length > formatted.length) {
    formatted.push(
      t("projectQueueBlockerMore", {
        count: blockers.length - formatted.length,
      }),
    );
  }
  return formatted.join("; ");
}

function readinessLabel(
  status: ProjectQueueProjectStatus | undefined,
  nowMs: number,
  t: Translate,
): string | null {
  if (!status) return null;
  switch (status.state) {
    case "paused":
      return t("projectQueueReadinessPaused");
    case "blocked":
      return t("projectQueueReadinessBlocked", {
        blockers: summarizeBlockers(status.blockers, t),
      });
    case "waiting-quiet": {
      const eligibleAt = status.quietEligibleAt
        ? new Date(status.quietEligibleAt).getTime()
        : Number.NaN;
      const waitMs = Number.isFinite(eligibleAt)
        ? Math.max(0, eligibleAt - nowMs)
        : status.quietWindowMs;
      return t("projectQueueReadinessWaitingQuiet", {
        duration: formatDurationSeconds(waitMs, t),
      });
    }
    case "ready":
      return t("projectQueueReadinessReady");
    case "dispatching":
      return t("projectQueueReadinessDispatching");
    case "empty":
      return t("projectQueueReadinessEmpty");
  }
}

function maxResumeQuietWindowMs(
  items: readonly ProjectQueueItemSummary[],
  projectStatusesByProject: Record<string, ProjectQueueProjectStatus>,
): number | null {
  let maxQuietWindowMs: number | null = null;
  const projectIds = new Set(items.map((item) => item.projectId));
  for (const projectId of projectIds) {
    const quietWindowMs = projectStatusesByProject[projectId]?.quietWindowMs;
    if (
      typeof quietWindowMs !== "number" ||
      !Number.isFinite(quietWindowMs) ||
      quietWindowMs <= 0
    ) {
      continue;
    }
    maxQuietWindowMs =
      maxQuietWindowMs === null
        ? quietWindowMs
        : Math.max(maxQuietWindowMs, quietWindowMs);
  }
  return maxQuietWindowMs;
}

function pausedNotice(
  pausedState: Extract<ProjectQueueDispatchState, { status: "paused" }>,
  items: readonly ProjectQueueItemSummary[],
  projectStatusesByProject: Record<string, ProjectQueueProjectStatus>,
  t: Translate,
): string {
  const quietWindowMs = maxResumeQuietWindowMs(items, projectStatusesByProject);
  if (quietWindowMs !== null) {
    return pausedState.reason === "restart"
      ? t("projectQueuePausedAfterRestartNoticeWithDelay", {
          duration: formatDurationSeconds(quietWindowMs, t),
        })
      : t("projectQueuePausedNoticeWithDelay", {
          duration: formatDurationSeconds(quietWindowMs, t),
        });
  }

  return pausedState.reason === "restart"
    ? t("projectQueuePausedAfterRestartNotice")
    : t("projectQueuePausedNotice");
}

function sessionLabel(
  item: ProjectQueueRecoveredSessionQueueSummary,
  t: Translate,
): string {
  return (
    item.sessionTitle?.trim() ||
    t("projectQueueTargetSession", {
      sessionId: item.sessionId.slice(0, 8),
    })
  );
}

interface RecoveredSessionQueueGroup {
  key: string;
  projectId: string;
  sessionId: string;
  sessionTitle?: string;
  items: ProjectQueueRecoveredSessionQueueSummary[];
}

interface ProjectQueueDisplayGroup {
  projectId: string;
  projectName: string;
  items: ProjectQueueItemSummary[];
}

function groupRecoveredSessionQueues(
  items: readonly ProjectQueueRecoveredSessionQueueSummary[],
): RecoveredSessionQueueGroup[] {
  const groups = new Map<string, RecoveredSessionQueueGroup>();
  for (const item of items) {
    const key = `${item.projectId}:${item.sessionId}`;
    const existing = groups.get(key);
    if (existing) {
      existing.items.push(item);
    } else {
      groups.set(key, {
        key,
        projectId: item.projectId,
        sessionId: item.sessionId,
        ...(item.sessionTitle ? { sessionTitle: item.sessionTitle } : {}),
        items: [item],
      });
    }
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      items: [...group.items].sort((left, right) => {
        const queued = (left.queuedAt ?? left.timestamp).localeCompare(
          right.queuedAt ?? right.timestamp,
        );
        return queued !== 0 ? queued : left.id.localeCompare(right.id);
      }),
    }))
    .sort((left, right) => {
      const project = left.projectId.localeCompare(right.projectId);
      if (project !== 0) return project;
      const leftQueued =
        left.items[0]?.queuedAt ?? left.items[0]?.timestamp ?? "";
      const rightQueued =
        right.items[0]?.queuedAt ?? right.items[0]?.timestamp ?? "";
      const queued = leftQueued.localeCompare(rightQueued);
      return queued !== 0
        ? queued
        : left.sessionId.localeCompare(right.sessionId);
    });
}

function compareDisplayNames(left: string, right: string): number {
  return left.localeCompare(right, undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

function groupProjectQueueItems(
  items: readonly ProjectQueueItemSummary[],
  projectById: Map<string, Project>,
  t: Translate,
): ProjectQueueDisplayGroup[] {
  const groups = new Map<string, ProjectQueueDisplayGroup>();
  for (const item of items) {
    const existing = groups.get(item.projectId);
    if (existing) {
      existing.items.push(item);
      continue;
    }
    groups.set(item.projectId, {
      projectId: item.projectId,
      projectName:
        projectById.get(item.projectId)?.name ??
        t("projectQueueUnknownProject"),
      items: [item],
    });
  }

  return [...groups.values()].sort((left, right) => {
    const name = compareDisplayNames(left.projectName, right.projectName);
    return name !== 0 ? name : left.projectId.localeCompare(right.projectId);
  });
}

function isFirstMovableProjectQueueItem(
  item: ProjectQueueItemSummary,
  items: readonly ProjectQueueItemSummary[],
): boolean {
  const firstMovable = items.find(
    (candidate) =>
      candidate.projectId === item.projectId &&
      candidate.status !== "dispatching",
  );
  return firstMovable?.id === item.id;
}

export function ProjectQueueSection({
  projects,
  items,
  recoveredSessionQueues = [],
  loading,
  error,
  mutatingItemId,
  mutatingDispatchState,
  mutatingPromoteItemId,
  dispatchState,
  projectStatusesByProject = {},
  highlightedItemId,
  basePath = "",
  onPauseDispatch,
  onResumeDispatch,
  onPromoteNow,
  onDeleteItem,
  onRetryItem,
  onMoveItemToTop,
  onUpdateItem,
}: ProjectQueueSectionProps) {
  const { t } = useI18n();
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [nowMs, setNowMs] = useState(() => Date.now());
  const highlightedItemRef = useRef<HTMLLIElement | null>(null);
  const projectById = new Map(projects.map((project) => [project.id, project]));
  const itemGroups = groupProjectQueueItems(items, projectById, t);
  const recoveredGroups = groupRecoveredSessionQueues(recoveredSessionQueues);
  const recoveredCount = recoveredSessionQueues.length;
  const hasProjectQueueItems = items.length > 0;
  const hasContent = hasProjectQueueItems || recoveredCount > 0;
  const highlightedItemIndex = highlightedItemId
    ? items.findIndex((item) => item.id === highlightedItemId)
    : -1;
  const pausedState =
    dispatchState.status === "paused" ? dispatchState : undefined;
  const description = pausedState
    ? pausedState.reason === "restart"
      ? t("projectQueuePausedAfterRestartDescription")
      : t("projectQueuePausedDescription")
    : t("projectQueueDescription");

  useEffect(() => {
    if (!editingItemId) return;
    if (items.some((item) => item.id === editingItemId)) return;
    setEditingItemId(null);
    setEditText("");
  }, [editingItemId, items]);

  useEffect(() => {
    if (!highlightedItemId || highlightedItemIndex < 0) return;
    highlightedItemRef.current?.scrollIntoView?.({
      block: "center",
      behavior: "smooth",
    });
  }, [highlightedItemId, highlightedItemIndex]);

  useEffect(() => {
    if (!hasProjectQueueItems) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [hasProjectQueueItems]);

  if (!hasContent && !error) return null;

  return (
    <section
      className="project-queue-section"
      aria-labelledby="project-queue-title"
    >
      <div className="project-queue-section__header">
        <div>
          <h2 id="project-queue-title">{t("projectQueueTitle")}</h2>
          <p>{description}</p>
        </div>
        <div className="project-queue-section__header-actions">
          {hasProjectQueueItems && (
            <span className="project-queue-section__count">
              {loading
                ? t("projectQueueRefreshing")
                : t("projectQueueCount", { count: items.length })}
            </span>
          )}
          {hasProjectQueueItems && (
            <button
              type="button"
              className="project-queue-section__dispatch-button"
              onClick={pausedState ? onResumeDispatch : onPauseDispatch}
              disabled={mutatingDispatchState}
            >
              {pausedState ? t("projectQueueResume") : t("projectQueuePause")}
            </button>
          )}
        </div>
      </div>

      {pausedState && hasProjectQueueItems && (
        <div className="project-queue-section__notice">
          {pausedNotice(pausedState, items, projectStatusesByProject, t)}
        </div>
      )}

      {error && (
        <div className="project-queue-section__error">
          {t("projectQueueLoadError", { message: error.message })}
        </div>
      )}

      {recoveredGroups.length > 0 && (
        <div className="project-queue-recovered">
          <div className="project-queue-recovered__header">
            <h3>{t("projectQueueRecoveredTitle")}</h3>
            <span className="project-queue-recovered__count">
              {t("projectQueueRecoveredCount", { count: recoveredCount })}
            </span>
          </div>
          <ul className="project-queue-recovered__groups">
            {recoveredGroups.map((group) => {
              const project = projectById.get(group.projectId);
              const firstItem = group.items[0];
              const label = firstItem
                ? sessionLabel(firstItem, t)
                : t("projectQueueTargetSession", {
                    sessionId: group.sessionId.slice(0, 8),
                  });
              return (
                <li className="project-queue-recovered__group" key={group.key}>
                  <div className="project-queue-recovered__group-header">
                    <span className="project-queue-recovered__project">
                      {project?.name ?? t("projectQueueUnknownProject")}
                    </span>
                    <Link
                      className="project-queue-recovered__session"
                      to={`${basePath}/projects/${group.projectId}/sessions/${group.sessionId}`}
                    >
                      {label}
                    </Link>
                    <span className="project-queue-recovered__status">
                      {t("sessionRecoveredQueuedPaused")}
                    </span>
                  </div>
                  <ul className="project-queue-recovered__messages">
                    {group.items.map((item) => (
                      <li
                        className="project-queue-recovered__message"
                        key={item.id}
                      >
                        <span className="project-queue-recovered__preview">
                          {item.content || t("projectQueueAttachmentOnly")}
                        </span>
                        <span className="project-queue-recovered__age">
                          {formatRelativeTime(
                            item.queuedAt ?? item.timestamp,
                            t,
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {hasProjectQueueItems && (
        <ul className="project-queue-groups">
          {itemGroups.map((group) => (
            <li className="project-queue-group" key={group.projectId}>
              <h3 className="project-queue-group__title">
                {group.projectName}
              </h3>
              <ul className="project-queue-list">
                {group.items.map((item) => {
                  const isMutating = mutatingItemId === item.id;
                  const isPromoting = mutatingPromoteItemId === item.id;
                  const isDispatching = item.status === "dispatching";
                  const isEditing = editingItemId === item.id;
                  const isHighlighted = highlightedItemId === item.id;
                  const canEdit =
                    item.status === "queued" || item.status === "failed";
                  const projectStatus =
                    projectStatusesByProject[item.projectId];
                  const readiness = readinessLabel(projectStatus, nowMs, t);
                  const blockerSummary = projectStatus
                    ? summarizeBlockers(projectStatus.blockers, t)
                    : "";
                  const forceStart =
                    item.status === "queued" &&
                    (projectStatus?.state === "blocked" ||
                      (pausedState !== undefined &&
                        projectStatus !== undefined &&
                        projectStatus.blockers.length > 0));
                  const canPromote =
                    item.status === "queued" &&
                    projectStatus?.state !== "dispatching";
                  const canMoveToTop =
                    canEdit && !isFirstMovableProjectQueueItem(item, items);
                  const canSaveEdit =
                    !isMutating &&
                    (editText.trim().length > 0 ||
                      (item.message.attachments?.length ?? 0) > 0);
                  const handleEditSubmit = async (
                    event: FormEvent<HTMLFormElement>,
                  ) => {
                    event.preventDefault();
                    if (!canSaveEdit) return;
                    await onUpdateItem(item.projectId, item.id, {
                      ...item.message,
                      text: editText,
                    });
                    setEditingItemId(null);
                    setEditText("");
                  };
                  return (
                    <li
                      key={item.id}
                      ref={isHighlighted ? highlightedItemRef : undefined}
                      className={`project-queue-item project-queue-item--${item.status}${
                        isHighlighted ? " project-queue-item--highlighted" : ""
                      }`}
                      data-project-queue-item-id={item.id}
                    >
                      <div className="project-queue-item__main">
                        <div className="project-queue-item__meta">
                          <span className="project-queue-item__target">
                            {item.target.type === "existing-session" ? (
                              <Link
                                to={`${basePath}/projects/${item.projectId}/sessions/${item.target.sessionId}`}
                              >
                                {targetLabel(item, t)}
                              </Link>
                            ) : (
                              targetLabel(item, t)
                            )}
                          </span>
                          <span className="project-queue-item__age">
                            {formatRelativeTime(item.createdAt, t)}
                          </span>
                        </div>
                        {isEditing ? (
                          <form
                            className="project-queue-item__edit"
                            onSubmit={handleEditSubmit}
                          >
                            <textarea
                              value={editText}
                              onChange={(event) =>
                                setEditText(event.target.value)
                              }
                              aria-label={t("projectQueueEditMessageLabel")}
                              disabled={isMutating}
                              rows={3}
                            />
                            <div className="project-queue-item__edit-actions">
                              <button
                                type="submit"
                                disabled={!canSaveEdit}
                                className="project-queue-item__save"
                              >
                                {t("projectQueueSave")}
                              </button>
                              <button
                                type="button"
                                disabled={isMutating}
                                onClick={() => {
                                  setEditingItemId(null);
                                  setEditText("");
                                }}
                              >
                                {t("projectQueueDiscard")}
                              </button>
                            </div>
                          </form>
                        ) : (
                          <div className="project-queue-item__preview">
                            {item.messagePreview ||
                              t("projectQueueAttachmentOnly")}
                          </div>
                        )}
                        {item.lastError && (
                          <div className="project-queue-item__error">
                            {item.lastError}
                          </div>
                        )}
                        {readiness && (
                          <div className="project-queue-item__readiness">
                            {readiness}
                          </div>
                        )}
                      </div>

                      <div className="project-queue-item__side">
                        <span
                          className={`project-queue-item__status project-queue-item__status--${item.status}`}
                        >
                          {statusLabel(item.status, t)}
                        </span>
                        <div className="project-queue-item__actions">
                          {pausedState && !isEditing && (
                            <button
                              type="button"
                              onClick={onResumeDispatch}
                              disabled={mutatingDispatchState}
                            >
                              {t("projectQueueResume")}
                            </button>
                          )}
                          {canPromote && !isEditing && (
                            <button
                              type="button"
                              className={
                                forceStart
                                  ? "project-queue-item__force-start"
                                  : undefined
                              }
                              onClick={() =>
                                onPromoteNow(item.projectId, item.id, {
                                  force: forceStart,
                                })
                              }
                              disabled={isMutating || isPromoting}
                              title={
                                forceStart
                                  ? t("projectQueueForceStartTitle", {
                                      blockers: blockerSummary,
                                    })
                                  : t("projectQueueStartNowTitle")
                              }
                            >
                              {isPromoting
                                ? t("projectQueuePromoting")
                                : forceStart
                                  ? t("projectQueueForceStart")
                                  : t("projectQueueStartNow")}
                            </button>
                          )}
                          {item.status === "failed" && !isEditing && (
                            <button
                              type="button"
                              onClick={() =>
                                onRetryItem(item.projectId, item.id)
                              }
                              disabled={isMutating}
                            >
                              {t("projectQueueRetry")}
                            </button>
                          )}
                          {canEdit && !isEditing && (
                            <button
                              type="button"
                              onClick={() => {
                                setEditingItemId(item.id);
                                setEditText(item.message.text);
                              }}
                              disabled={isMutating}
                            >
                              {t("projectQueueEdit")}
                            </button>
                          )}
                          {canMoveToTop && !isEditing && (
                            <button
                              type="button"
                              onClick={() =>
                                onMoveItemToTop(item.projectId, item.id)
                              }
                              disabled={isMutating}
                            >
                              {t("projectQueueMoveToTop")}
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() =>
                              onDeleteItem(item.projectId, item.id)
                            }
                            disabled={isMutating || isDispatching}
                          >
                            {t("projectQueueDelete")}
                          </button>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
