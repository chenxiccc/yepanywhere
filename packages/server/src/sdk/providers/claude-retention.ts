import type { ProviderRetentionSnapshot, SDKMessage } from "../types.js";

type StopHookLike = {
  hook_event_name?: unknown;
  background_tasks?: unknown;
  session_crons?: unknown;
};

type TaskPatchLike = {
  status?: unknown;
  is_backgrounded?: unknown;
};

type BackgroundTaskLike = {
  task_id?: unknown;
  ambient?: unknown;
};

interface RetainedTask {
  status: string;
  isBackgrounded?: boolean;
}

const TERMINAL_TASK_STATUSES = new Set([
  "completed",
  "failed",
  "killed",
  "stopped",
]);

function readTaskId(message: SDKMessage): string | null {
  return typeof message.task_id === "string" && message.task_id
    ? message.task_id
    : null;
}

function readTaskPatch(message: SDKMessage): TaskPatchLike | null {
  const patch = message.patch;
  return patch && typeof patch === "object" ? patch : null;
}

function readBackgroundTasks(
  message: SDKMessage,
): Array<{ taskId: string; ambient: boolean }> | null {
  if (!Array.isArray(message.tasks)) {
    return null;
  }

  const tasks: Array<{ taskId: string; ambient: boolean }> = [];
  for (const task of message.tasks) {
    if (!task || typeof task !== "object") {
      return null;
    }
    const { task_id: taskId, ambient } = task as BackgroundTaskLike;
    if (typeof taskId !== "string" || !taskId) {
      return null;
    }
    tasks.push({ taskId, ambient: ambient === true });
  }
  return tasks;
}

function isStopHookInput(input: unknown): input is StopHookLike {
  return (
    !!input &&
    typeof input === "object" &&
    (input as StopHookLike).hook_event_name === "Stop"
  );
}

export class ClaudeProviderRetentionTracker {
  private stopBackgroundTaskCount = 0;
  private stopSessionCronCount = 0;
  private retainedTasks = new Map<string, RetainedTask>();
  private backgroundTaskSnapshotSeen = false;
  private lastUpdatedAt: Date | null = null;

  constructor(private readonly onChange?: () => void) {}

  getSnapshot(): ProviderRetentionSnapshot {
    const reasons: string[] = [];
    if (this.stopBackgroundTaskCount > 0) {
      reasons.push(
        `stop-hook-background-tasks:${this.stopBackgroundTaskCount}`,
      );
    }
    if (this.stopSessionCronCount > 0) {
      reasons.push(`stop-hook-session-crons:${this.stopSessionCronCount}`);
    }
    if (this.retainedTasks.size > 0) {
      reasons.push(`sdk-live-tasks:${this.retainedTasks.size}`);
    }

    return {
      retained: reasons.length > 0,
      reasons,
      backgroundTaskCount: this.stopBackgroundTaskCount,
      sessionCronCount: this.stopSessionCronCount,
      liveTaskCount: this.retainedTasks.size,
      lastUpdatedAt: this.lastUpdatedAt,
    };
  }

  observeStopHook(input: unknown): void {
    if (!isStopHookInput(input)) {
      return;
    }

    const previous = this.snapshotKey();
    const backgroundTasks = Array.isArray(input.background_tasks)
      ? input.background_tasks
      : null;
    const sessionCrons = Array.isArray(input.session_crons)
      ? input.session_crons
      : null;

    if (backgroundTasks === null && sessionCrons === null) {
      return;
    }

    if (backgroundTasks !== null) {
      this.stopBackgroundTaskCount = this.backgroundTaskSnapshotSeen
        ? 0
        : backgroundTasks.length;
    }
    if (sessionCrons !== null) {
      this.stopSessionCronCount = sessionCrons.length;
    }
    if (
      !this.backgroundTaskSnapshotSeen &&
      backgroundTasks !== null &&
      sessionCrons !== null &&
      backgroundTasks.length === 0 &&
      sessionCrons.length === 0
    ) {
      this.retainedTasks.clear();
    }
    this.markUpdated(previous);
  }

  observeMessage(message: SDKMessage): void {
    if (message.type !== "system") {
      return;
    }

    switch (message.subtype) {
      case "background_tasks_changed":
        this.observeBackgroundTasksChanged(message);
        break;
      case "task_started":
        if (message.ambient === true) {
          this.clearTaskFromMessage(message);
          break;
        }
        this.retainTaskFromMessage(message, "running");
        break;
      case "task_progress":
        this.retainTaskFromMessage(message, "running");
        break;
      case "task_updated":
        this.observeTaskUpdated(message);
        break;
      case "task_notification":
        this.clearTaskFromMessage(message);
        break;
    }
  }

  private observeBackgroundTasksChanged(message: SDKMessage): void {
    const tasks = readBackgroundTasks(message);
    if (!tasks) {
      return;
    }

    const previous = this.snapshotKey();
    this.backgroundTaskSnapshotSeen = true;
    this.stopBackgroundTaskCount = 0;
    this.retainedTasks = new Map(
      tasks
        .filter((task) => !task.ambient)
        .map((task) => [
          task.taskId,
          { status: "running", isBackgrounded: true },
        ]),
    );
    this.markUpdated(previous);
  }

  private retainTaskFromMessage(message: SDKMessage, status: string): void {
    if (this.backgroundTaskSnapshotSeen) {
      return;
    }
    const taskId = readTaskId(message);
    if (!taskId) {
      return;
    }

    const previous = this.snapshotKey();
    this.retainedTasks.set(taskId, {
      status,
      isBackgrounded: this.retainedTasks.get(taskId)?.isBackgrounded,
    });
    this.markUpdated(previous);
  }

  private observeTaskUpdated(message: SDKMessage): void {
    if (this.backgroundTaskSnapshotSeen) {
      return;
    }
    const taskId = readTaskId(message);
    const patch = readTaskPatch(message);
    if (!taskId || !patch) {
      return;
    }

    const status = typeof patch.status === "string" ? patch.status : undefined;
    if (status && TERMINAL_TASK_STATUSES.has(status)) {
      this.clearTask(taskId);
      return;
    }

    const existing = this.retainedTasks.get(taskId);
    const shouldRetain =
      !!status ||
      patch.is_backgrounded === true ||
      (patch.is_backgrounded === false && !!existing);
    if (!shouldRetain) {
      return;
    }

    const previous = this.snapshotKey();
    this.retainedTasks.set(taskId, {
      status: status ?? existing?.status ?? "unknown",
      isBackgrounded:
        typeof patch.is_backgrounded === "boolean"
          ? patch.is_backgrounded
          : existing?.isBackgrounded,
    });
    this.markUpdated(previous);
  }

  private clearTaskFromMessage(message: SDKMessage): void {
    if (this.backgroundTaskSnapshotSeen) {
      return;
    }
    const taskId = readTaskId(message);
    if (!taskId) {
      return;
    }
    this.clearTask(taskId);
  }

  private clearTask(taskId: string): void {
    if (!this.retainedTasks.has(taskId)) {
      return;
    }

    const previous = this.snapshotKey();
    this.retainedTasks.delete(taskId);
    this.markUpdated(previous);
  }

  private markUpdated(previousKey: string): void {
    this.lastUpdatedAt = new Date();
    if (this.snapshotKey() !== previousKey) {
      this.onChange?.();
    }
  }

  private snapshotKey(): string {
    const tasks = Array.from(this.retainedTasks.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(
        ([id, task]) =>
          `${id}:${task.status}:${task.isBackgrounded === true ? "bg" : "fg"}`,
      )
      .join(",");
    return [
      this.stopBackgroundTaskCount,
      this.stopSessionCronCount,
      tasks,
    ].join("|");
  }
}
