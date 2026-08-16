import { isStaleTimestamp, parseTimestampMs } from "../messageAge";

export interface RenderPendingMessage {
  tempId: string;
  timestamp: string;
  clientOrder?: number;
}

export interface RenderDeferredMessage {
  attachmentCount?: number | null;
  attachments?: readonly unknown[] | null;
  id?: string;
  tempId?: string;
  timestamp: string;
  status?: string;
  kind?: string;
  yaCommand?: string;
  metadata?: {
    deliveryIntent?: string;
  };
}

export interface RenderProjectQueueMessage {
  attachmentCount?: number | null;
  attachments?: readonly unknown[] | null;
  id: string;
  status?: string | null;
  timestamp: string;
  projectPosition: number;
}

export interface ComposerTailLanePosition {
  regularIndex?: number;
  patientIndex?: number;
}

export type ComposerTailItem<
  TPending extends RenderPendingMessage = RenderPendingMessage,
  TDeferred extends RenderDeferredMessage = RenderDeferredMessage,
  TProjectQueue extends RenderProjectQueueMessage = RenderProjectQueueMessage,
> =
  | {
      kind: "pending";
      key: string;
      message: TPending;
      sourceIndex: number;
    }
  | {
      kind: "deferred";
      key: string;
      message: TDeferred;
      deferredIndex: number;
      sourceIndex: number;
    }
  | {
      kind: "project-queue";
      key: string;
      message: TProjectQueue;
      sourceIndex: number;
    };

export interface ComposerTailItemsInput<
  TPending extends RenderPendingMessage = RenderPendingMessage,
  TDeferred extends RenderDeferredMessage = RenderDeferredMessage,
  TProjectQueue extends RenderProjectQueueMessage = RenderProjectQueueMessage,
> {
  deferredMessages?: readonly TDeferred[];
  pendingMessages?: readonly TPending[];
  projectQueueMessages?: readonly TProjectQueue[];
}

export type ProjectQueueTailStatusKind = "dispatching" | "failed" | "queued";

interface ComposerTailDisplayRowBase {
  hasMessageAge: boolean;
  key: string;
  showAgeByDefault: boolean;
  sourceIndex: number;
  timestampMs: number | null;
}

export type ComposerTailDisplayRow<
  TPending extends RenderPendingMessage = RenderPendingMessage,
  TDeferred extends RenderDeferredMessage = RenderDeferredMessage,
  TProjectQueue extends RenderProjectQueueMessage = RenderProjectQueueMessage,
> =
  | (ComposerTailDisplayRowBase & {
      kind: "pending";
      message: TPending;
    })
  | (ComposerTailDisplayRowBase & {
      allowsDeferredCancel: boolean;
      allowsRecoveredDelete: boolean;
      allowsRecoveredResume: boolean;
      deferredIndex: number;
      isPatient: boolean;
      isRecovered: boolean;
      isYaCommand: boolean;
      kind: "deferred";
      lanePosition: ComposerTailLanePosition | undefined;
      message: TDeferred;
      recoveredQueueId: string | null;
      showAttachmentCountBadge: boolean;
    })
  | (ComposerTailDisplayRowBase & {
      allowsCancel: boolean;
      kind: "project-queue";
      message: TProjectQueue;
      projectQueueStatusKind: ProjectQueueTailStatusKind;
      showAttachmentCountBadge: boolean;
    });

export interface ComposerTailDisplayRowsInput<
  TPending extends RenderPendingMessage = RenderPendingMessage,
  TDeferred extends RenderDeferredMessage = RenderDeferredMessage,
  TProjectQueue extends RenderProjectQueueMessage = RenderProjectQueueMessage,
> extends ComposerTailItemsInput<TPending, TDeferred, TProjectQueue> {
  latestVisibleTimestampMs: number | null;
  nowMs: number;
  staleThresholdMs: number;
}

export function isPatientDeferredMessage(
  message: RenderDeferredMessage,
): boolean {
  return message.metadata?.deliveryIntent === "patient";
}

export function isRecoveredDeferredMessage(
  message: RenderDeferredMessage,
): boolean {
  return message.status === "paused-after-restart";
}

export function isYaCommandDeferredMessage(
  message: RenderDeferredMessage,
): boolean {
  return message.kind === "ya-command" && Boolean(message.yaCommand);
}

export function compareComposerTailItems(
  left: ComposerTailItem,
  right: ComposerTailItem,
): number {
  // Two lanes, each kept in its own order: optimistic pending sends (in flight)
  // render before server-queued deferred messages, and deferred messages
  // preserve the server's authoritative queue order rather than being re-sorted.
  if (left.kind !== right.kind) {
    const laneRank = { pending: 0, deferred: 1, "project-queue": 2 };
    return laneRank[left.kind] - laneRank[right.kind];
  }

  if (left.kind === "deferred" && right.kind === "deferred") {
    return left.deferredIndex - right.deferredIndex;
  }

  if (left.kind === "project-queue" && right.kind === "project-queue") {
    return left.message.projectPosition - right.message.projectPosition;
  }

  const leftOrder =
    left.kind === "pending" ? left.message.clientOrder : undefined;
  const rightOrder =
    right.kind === "pending" ? right.message.clientOrder : undefined;
  if (
    typeof leftOrder === "number" &&
    Number.isFinite(leftOrder) &&
    typeof rightOrder === "number" &&
    Number.isFinite(rightOrder) &&
    leftOrder !== rightOrder
  ) {
    return leftOrder - rightOrder;
  }

  const leftTimestamp = parseTimestampMs(left.message.timestamp);
  const rightTimestamp = parseTimestampMs(right.message.timestamp);
  if (
    leftTimestamp !== null &&
    rightTimestamp !== null &&
    leftTimestamp !== rightTimestamp
  ) {
    return leftTimestamp - rightTimestamp;
  }

  return left.sourceIndex - right.sourceIndex;
}

export function buildComposerTailItems<
  TPending extends RenderPendingMessage = RenderPendingMessage,
  TDeferred extends RenderDeferredMessage = RenderDeferredMessage,
  TProjectQueue extends RenderProjectQueueMessage = RenderProjectQueueMessage,
>({
  deferredMessages = [],
  pendingMessages = [],
  projectQueueMessages = [],
}: ComposerTailItemsInput<TPending, TDeferred, TProjectQueue>): Array<
  ComposerTailItem<TPending, TDeferred, TProjectQueue>
> {
  let sourceIndex = 0;
  const items: Array<ComposerTailItem<TPending, TDeferred, TProjectQueue>> = [];

  for (const pending of pendingMessages) {
    items.push({
      kind: "pending",
      key: pending.tempId,
      message: pending,
      sourceIndex: sourceIndex++,
    });
  }
  deferredMessages.forEach((deferred, deferredIndex) => {
    items.push({
      kind: "deferred",
      key: deferred.tempId ?? `deferred-${deferredIndex}`,
      message: deferred,
      deferredIndex,
      sourceIndex: sourceIndex++,
    });
  });
  for (const projectQueue of projectQueueMessages) {
    items.push({
      kind: "project-queue",
      key: `project-queue-${projectQueue.id}`,
      message: projectQueue,
      sourceIndex: sourceIndex++,
    });
  }

  return items.sort(compareComposerTailItems) as Array<
    ComposerTailItem<TPending, TDeferred, TProjectQueue>
  >;
}

export function getComposerTailLanePositions<
  TPending extends RenderPendingMessage = RenderPendingMessage,
  TDeferred extends RenderDeferredMessage = RenderDeferredMessage,
  TProjectQueue extends RenderProjectQueueMessage = RenderProjectQueueMessage,
>(
  items: readonly ComposerTailItem<TPending, TDeferred, TProjectQueue>[],
): Map<string, ComposerTailLanePosition> {
  const positions = new Map<string, ComposerTailLanePosition>();
  let regularIndex = 0;
  let patientIndex = 0;

  for (const item of items) {
    if (item.kind !== "deferred") {
      continue;
    }
    if (isYaCommandDeferredMessage(item.message)) {
      continue;
    }
    if (isPatientDeferredMessage(item.message)) {
      positions.set(item.key, { patientIndex });
      patientIndex += 1;
    } else {
      positions.set(item.key, { regularIndex });
      regularIndex += 1;
    }
  }

  return positions;
}

function getProjectQueueTailStatusKind(
  message: RenderProjectQueueMessage,
): ProjectQueueTailStatusKind {
  if (message.status === "dispatching") {
    return "dispatching";
  }
  return message.status === "failed" ? "failed" : "queued";
}

function showTailAttachmentCountBadge(message: {
  attachmentCount?: number | null;
  attachments?: readonly unknown[] | null;
}): boolean {
  return Boolean(message.attachmentCount && !message.attachments?.length);
}

export function buildComposerTailDisplayRows<
  TPending extends RenderPendingMessage = RenderPendingMessage,
  TDeferred extends RenderDeferredMessage = RenderDeferredMessage,
  TProjectQueue extends RenderProjectQueueMessage = RenderProjectQueueMessage,
>({
  deferredMessages,
  latestVisibleTimestampMs,
  nowMs,
  pendingMessages,
  projectQueueMessages,
  staleThresholdMs,
}: ComposerTailDisplayRowsInput<TPending, TDeferred, TProjectQueue>): Array<
  ComposerTailDisplayRow<TPending, TDeferred, TProjectQueue>
> {
  const tailItems = buildComposerTailItems({
    deferredMessages,
    pendingMessages,
    projectQueueMessages,
  });
  const lanePositions = getComposerTailLanePositions(tailItems);

  return tailItems.map((item) => {
    const timestampMs = parseTimestampMs(item.message.timestamp);
    const base = {
      hasMessageAge: timestampMs !== null,
      key: item.key,
      showAgeByDefault:
        timestampMs !== null &&
        latestVisibleTimestampMs === timestampMs &&
        isStaleTimestamp(timestampMs, nowMs, staleThresholdMs),
      sourceIndex: item.sourceIndex,
      timestampMs,
    };

    if (item.kind === "pending") {
      return {
        ...base,
        kind: "pending",
        message: item.message,
      };
    }

    if (item.kind === "project-queue") {
      return {
        ...base,
        allowsCancel: item.message.status !== "dispatching",
        kind: "project-queue",
        message: item.message,
        projectQueueStatusKind: getProjectQueueTailStatusKind(item.message),
        showAttachmentCountBadge: showTailAttachmentCountBadge(item.message),
      };
    }

    const isRecovered = isRecoveredDeferredMessage(item.message);
    const isYaCommand = isYaCommandDeferredMessage(item.message);
    const recoveredQueueId =
      isRecovered && item.message.id ? item.message.id : null;
    return {
      ...base,
      allowsDeferredCancel: !isYaCommand && Boolean(item.message.tempId),
      allowsRecoveredDelete: recoveredQueueId !== null,
      allowsRecoveredResume: recoveredQueueId !== null,
      deferredIndex: item.deferredIndex,
      isPatient: isPatientDeferredMessage(item.message),
      isRecovered,
      isYaCommand,
      kind: "deferred",
      lanePosition: lanePositions.get(item.key),
      message: item.message,
      recoveredQueueId,
      showAttachmentCountBadge: Boolean(item.message.attachmentCount),
    };
  });
}
