import type { GlobalSessionItem } from "../api/client";
import type { SessionCollectionRecord } from "./clientSummaryCollections";

export function sessionCollectionRecordToGlobalSessionItem(
  record: SessionCollectionRecord,
): GlobalSessionItem | null {
  const updatedAt = record.updatedAt ?? record.createdAt;
  const createdAt = record.createdAt ?? updatedAt;
  if (!record.provider || !record.projectId || !createdAt || !updatedAt) {
    return null;
  }

  return {
    id: record.id,
    title: record.title ?? null,
    fullTitle: record.fullTitle ?? null,
    createdAt,
    updatedAt,
    messageCount: record.messageCount ?? 0,
    provider: record.provider,
    model: record.model,
    projectId: record.projectId,
    projectName: record.projectName ?? "",
    ownership: record.ownership ?? { owner: "none" },
    pendingInputType: record.pendingInputType,
    activity: record.activity,
    hasUnread: record.hasUnread,
    customTitle: record.customTitle,
    isArchived: record.isArchived,
    isStarred: record.isStarred,
    autoResumeDisabled: record.autoResumeDisabled,
    parentSessionId: record.parentSessionId,
    parentSessionKind: record.parentSessionKind,
    forkedFromSessionId: record.forkedFromSessionId,
    initialPrompt: record.initialPrompt,
    executor: record.executor,
    lastAgentText: record.lastAgentText,
  };
}

export function sessionCollectionRecordsToGlobalSessionItems(
  records: readonly SessionCollectionRecord[],
): GlobalSessionItem[] {
  const sessions: GlobalSessionItem[] = [];
  for (const record of records) {
    const session = sessionCollectionRecordToGlobalSessionItem(record);
    if (session) {
      sessions.push(session);
    }
  }
  return sessions;
}
