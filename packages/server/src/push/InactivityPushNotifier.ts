/**
 * InactivityPushNotifier - Sends push notifications for broad quiet edges.
 *
 * This listens to existing lifecycle and queue events, then runs a debounced
 * one-shot recheck. It does not poll and does not create per-session timers.
 */

import type {
  ProjectQueueItemSummary,
  UrlProjectId,
} from "@yep-anywhere/shared";
import { decodeProjectId, getProjectName } from "../projects/paths.js";
import {
  getProjectWorkIdleStatus,
  type ProjectWorkExternalTracker,
  type ProjectWorkSupervisor,
} from "../services/projectWorkIdle.js";
import type { BusEvent, EventBus } from "../watcher/EventBus.js";
import type { PushService } from "./PushService.js";
import type { ProjectInactivePayload, YaInactivePayload } from "./types.js";

const DEFAULT_DEBOUNCE_MS = 1500;

interface ProjectQueueReader {
  listAll(): ProjectQueueItemSummary[];
}

interface EdgeState {
  active: boolean;
  seenActive: boolean;
}

interface ProjectInactiveStatus {
  inactive: boolean;
  blockers: string[];
  failedProjectQueueCount: number;
}

export interface InactivityPushNotifierOptions {
  eventBus: EventBus;
  pushService: PushService;
  supervisor: ProjectWorkSupervisor;
  projectQueueService?: ProjectQueueReader;
  externalTracker?: ProjectWorkExternalTracker;
  debounceMs?: number;
}

export class InactivityPushNotifier {
  private readonly eventBus: EventBus;
  private readonly pushService: PushService;
  private readonly supervisor: ProjectWorkSupervisor;
  private readonly projectQueueService?: ProjectQueueReader;
  private readonly externalTracker?: ProjectWorkExternalTracker;
  private readonly debounceMs: number;
  private readonly unsubscribe: () => void;
  private readonly projectStates = new Map<UrlProjectId, EdgeState>();
  private readonly dirtyProjects = new Set<UrlProjectId>();
  private checkAllKnownProjects = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight = false;
  private runAgain = false;
  private disposed = false;
  private globalState: EdgeState = { active: false, seenActive: false };

  constructor(options: InactivityPushNotifierOptions) {
    this.eventBus = options.eventBus;
    this.pushService = options.pushService;
    this.supervisor = options.supervisor;
    this.projectQueueService = options.projectQueueService;
    this.externalTracker = options.externalTracker;
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.unsubscribe = this.eventBus.subscribe((event) => {
      this.handleEvent(event);
    });
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribe();
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.dirtyProjects.clear();
    this.projectStates.clear();
  }

  private handleEvent(event: BusEvent): void {
    switch (event.type) {
      case "process-state-changed":
      case "process-terminated":
      case "session-aborted":
      case "session-status-changed":
      case "session-updated":
      case "project-queue-changed":
      case "queue-request-added":
        this.markProjectDirty(event.projectId);
        break;
      case "session-created":
        this.markProjectDirty(event.session.projectId);
        break;
      case "queue-position-changed":
      case "queue-request-removed":
      case "worker-activity-changed":
        this.markAllKnownProjectsDirty();
        break;
    }
  }

  private markProjectDirty(projectId: UrlProjectId): void {
    if (this.disposed) return;
    this.dirtyProjects.add(projectId);
    this.scheduleCheck();
  }

  private markAllKnownProjectsDirty(): void {
    if (this.disposed) return;
    this.checkAllKnownProjects = true;
    this.scheduleCheck();
  }

  private scheduleCheck(): void {
    if (this.disposed) return;
    if (this.inFlight) {
      this.runAgain = true;
      return;
    }

    if (this.timer) {
      clearTimeout(this.timer);
    }

    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runChecks();
    }, this.debounceMs);
    this.timer.unref?.();
  }

  private async runChecks(): Promise<void> {
    if (this.inFlight || this.disposed) {
      this.runAgain = this.inFlight;
      return;
    }

    this.inFlight = true;
    try {
      const projectIds = await this.consumeDirtyProjectIds();
      const projectEdges: ProjectInactivePayload[] = [];

      for (const projectId of projectIds) {
        const status = await this.getProjectInactiveStatus(projectId);
        const edge = this.updateProjectState(projectId, status);
        if (edge) {
          projectEdges.push(edge);
        }
      }

      const globalEdge = await this.updateGlobalState();
      const yaEnabled = this.pushService.isNotificationTypeEnabled("yaInactive");

      if (globalEdge && yaEnabled) {
        await this.sendYaInactive(globalEdge);
      } else if (
        projectEdges.length > 0 &&
        this.pushService.isNotificationTypeEnabled("projectInactive")
      ) {
        for (const payload of projectEdges) {
          await this.sendProjectInactive(payload);
        }
      }
    } catch (error) {
      console.error("[InactivityPushNotifier] Failed inactivity check:", error);
    } finally {
      this.inFlight = false;
      if (!this.disposed && (this.runAgain || this.hasDirtyWork())) {
        this.runAgain = false;
        this.scheduleCheck();
      }
    }
  }

  private async consumeDirtyProjectIds(): Promise<Set<UrlProjectId>> {
    const projectIds = new Set(this.dirtyProjects);
    this.dirtyProjects.clear();

    if (this.checkAllKnownProjects) {
      this.checkAllKnownProjects = false;
      for (const projectId of await this.getKnownProjectIds()) {
        projectIds.add(projectId);
      }
    }

    return projectIds;
  }

  private hasDirtyWork(): boolean {
    return this.dirtyProjects.size > 0 || this.checkAllKnownProjects;
  }

  private updateProjectState(
    projectId: UrlProjectId,
    status: ProjectInactiveStatus,
  ): ProjectInactivePayload | null {
    const previous = this.projectStates.get(projectId) ?? {
      active: false,
      seenActive: false,
    };

    if (!status.inactive) {
      this.projectStates.set(projectId, {
        active: true,
        seenActive: true,
      });
      return null;
    }

    this.projectStates.set(projectId, {
      active: false,
      seenActive: previous.seenActive,
    });

    if (!previous.active || !previous.seenActive) {
      return null;
    }

    return {
      type: "project-inactive",
      projectId,
      projectName: this.getProjectName(projectId),
      ...(status.failedProjectQueueCount > 0
        ? { failedProjectQueueCount: status.failedProjectQueueCount }
        : {}),
      timestamp: new Date().toISOString(),
    };
  }

  private async updateGlobalState(): Promise<YaInactivePayload | null> {
    const knownProjectIds = await this.getKnownProjectIds();
    const statuses = await Promise.all(
      knownProjectIds.map((projectId) => this.getProjectInactiveStatus(projectId)),
    );
    const inactive = statuses.every((status) => status.inactive);
    const previous = this.globalState;

    if (!inactive) {
      this.globalState = { active: true, seenActive: true };
      return null;
    }

    this.globalState = {
      active: false,
      seenActive: previous.seenActive,
    };

    if (!previous.active || !previous.seenActive) {
      return null;
    }

    return {
      type: "ya-inactive",
      projectCount: knownProjectIds.length,
      timestamp: new Date().toISOString(),
    };
  }

  private async getProjectInactiveStatus(
    projectId: UrlProjectId,
  ): Promise<ProjectInactiveStatus> {
    const workIdle = await getProjectWorkIdleStatus(projectId, {
      supervisor: this.supervisor,
      externalTracker: this.externalTracker,
    });
    const blockers = [...workIdle.blockers];
    let failedProjectQueueCount = 0;

    for (const item of this.projectQueueService?.listAll() ?? []) {
      if (item.projectId !== projectId) continue;
      if (item.status === "queued" || item.status === "dispatching") {
        blockers.push(`project-queue:${item.status}`);
      } else if (item.status === "failed") {
        failedProjectQueueCount++;
      }
    }

    return {
      inactive: blockers.length === 0,
      blockers,
      failedProjectQueueCount,
    };
  }

  private async getKnownProjectIds(): Promise<UrlProjectId[]> {
    const projectIds = new Set<UrlProjectId>();

    for (const projectId of this.projectStates.keys()) {
      projectIds.add(projectId);
    }
    for (const projectId of this.dirtyProjects) {
      projectIds.add(projectId);
    }
    for (const process of this.supervisor.getAllProcesses()) {
      projectIds.add(process.projectId);
    }
    for (const request of this.supervisor.getQueueInfo()) {
      projectIds.add(request.projectId);
    }
    for (const item of this.projectQueueService?.listAll() ?? []) {
      projectIds.add(item.projectId);
    }

    if (this.externalTracker) {
      for (const sessionId of this.externalTracker.getExternalSessions()) {
        const info =
          await this.externalTracker.getExternalSessionInfoWithUrlId(sessionId);
        if (info) {
          projectIds.add(info.projectId);
        }
      }
    }

    return [...projectIds];
  }

  private async sendProjectInactive(
    payload: ProjectInactivePayload,
  ): Promise<void> {
    if (this.pushService.getSubscriptionCount() === 0) {
      return;
    }

    try {
      const results = await this.pushService.sendToAll(payload);
      const successCount = results.filter((result) => result.success).length;
      if (successCount > 0) {
        console.log(
          `[InactivityPushNotifier] Sent project-inactive notification to ${successCount}/${results.length} devices`,
        );
      }
    } catch (error) {
      console.error(
        "[InactivityPushNotifier] Failed to send project-inactive notification:",
        error,
      );
    }
  }

  private async sendYaInactive(payload: YaInactivePayload): Promise<void> {
    if (this.pushService.getSubscriptionCount() === 0) {
      return;
    }

    try {
      const results = await this.pushService.sendToAll(payload);
      const successCount = results.filter((result) => result.success).length;
      if (successCount > 0) {
        console.log(
          `[InactivityPushNotifier] Sent ya-inactive notification to ${successCount}/${results.length} devices`,
        );
      }
    } catch (error) {
      console.error(
        "[InactivityPushNotifier] Failed to send ya-inactive notification:",
        error,
      );
    }
  }

  private getProjectName(projectId: UrlProjectId): string {
    try {
      const projectPath = decodeProjectId(projectId);
      return getProjectName(projectPath);
    } catch {
      return "Unknown Project";
    }
  }
}
