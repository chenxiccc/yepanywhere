/** Provider-neutral assistant-turn boundary for bounded review responses. */

import type { ReviewCommentService } from "./ReviewCommentService.js";
import type { ReviewResponseReadStatus } from "./ReviewCommentService.js";

export interface ReviewResponseProcess {
  id: string;
  sessionId: string;
  projectPath: string;
  assistantActivityVersion: number;
}

export class ReviewResponseObserver {
  private observedVersions = new Map<string, number>();

  constructor(private service: ReviewCommentService) {}

  /** Observe at most once for each completed-assistant activity version. */
  async observeIdle(process: ReviewResponseProcess): Promise<Array<{
    submissionId: string;
    status: ReviewResponseReadStatus;
  }> | null> {
    const current = process.assistantActivityVersion;
    const previous = this.observedVersions.get(process.id) ?? 0;
    if (current <= previous) return null;
    this.observedVersions.set(process.id, current);
    try {
      return await this.service.observeAssistantTurn(
        process.projectPath,
        process.sessionId,
      );
    } catch (error) {
      if (this.observedVersions.get(process.id) === current) {
        this.observedVersions.set(process.id, previous);
      }
      throw error;
    }
  }

  forget(processId: string): void {
    this.observedVersions.delete(processId);
  }
}
