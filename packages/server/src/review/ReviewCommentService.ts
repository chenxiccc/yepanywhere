/**
 * ReviewCommentService — server-owned source-review draft comments.
 *
 * The single authority for pending/archived review comments (topic:
 * source-review-to-session). Drafts persist per project in
 * `{projectPath}/.yep/review-comments.json` so a review started on one device
 * continues on another with the same pending set and archive. Keyed by the
 * project path itself, two repos' drafts can never mix.
 *
 * Persistence: typed state, load once per project, atomic writes coalesced
 * per project through the shared saver. The file is user-visible on disk and
 * outlives bundle versions, so every load runs through the shared defensive
 * parser and a corrupt/truncated file degrades to an empty store.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  MAX_REVIEW_COMMENTS,
  type ReviewBatch,
  type ReviewComment,
  type ReviewCommentAnchor,
  type ReviewCommentsFile,
  emptyReviewCommentsFile,
  parseReviewCommentsFile,
} from "@yep-anywhere/shared";
import { createCoalescingSaver } from "../lib/coalescingSaver.js";
import { HttpError } from "../middleware/error-handler.js";
import { ensureManagedProjectDir } from "../projects/managedProjectDir.js";

const YEP_DIR = ".yep";
const REVIEW_COMMENTS_FILENAME = "review-comments.json";

interface ProjectStore {
  state: ReviewCommentsFile;
  loadPromise: Promise<void> | null;
  loaded: boolean;
  dirEnsured: boolean;
  save: () => Promise<void>;
}

export interface AddReviewCommentInput {
  anchor: ReviewCommentAnchor;
  text: string;
}

export interface UpdateReviewCommentInput {
  text?: string;
  anchor?: ReviewCommentAnchor;
}

export interface ArchiveReviewCommentsInput {
  commentIds: string[];
  targetSessionId: string;
  /** Defaults to now; injectable for deterministic tests. */
  submittedAt?: string;
}

/** Deps let tests stub the clock and id source for stable assertions. */
export interface ReviewCommentServiceOptions {
  now?: () => string;
  newId?: () => string;
}

export class ReviewCommentService {
  private stores = new Map<string, ProjectStore>();
  private now: () => string;
  private newId: () => string;

  constructor(options: ReviewCommentServiceOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.newId = options.newId ?? (() => randomUUID());
  }

  /** The whole persisted store (comments + batches) for a project. */
  async getFile(projectPath: string): Promise<ReviewCommentsFile> {
    const store = await this.getStore(projectPath);
    return cloneFile(store.state);
  }

  async listComments(projectPath: string): Promise<ReviewComment[]> {
    const store = await this.getStore(projectPath);
    return store.state.comments.map(cloneComment);
  }

  async listPending(projectPath: string): Promise<ReviewComment[]> {
    const store = await this.getStore(projectPath);
    return store.state.comments
      .filter((c) => c.status === "pending")
      .map(cloneComment);
  }

  async getComment(
    projectPath: string,
    id: string,
  ): Promise<ReviewComment | null> {
    const store = await this.getStore(projectPath);
    const found = store.state.comments.find((c) => c.id === id);
    return found ? cloneComment(found) : null;
  }

  async addComment(
    projectPath: string,
    input: AddReviewCommentInput,
  ): Promise<ReviewComment> {
    const store = await this.getStore(projectPath);
    // The load parser silently drops entries past this bound, so exceeding it
    // here would persist comments that vanish on the next restart.
    if (store.state.comments.length >= MAX_REVIEW_COMMENTS) {
      throw new HttpError(
        413,
        `Review comment limit reached (${MAX_REVIEW_COMMENTS}); submit or delete drafts first.`,
      );
    }
    const comment: ReviewComment = {
      id: this.newId(),
      anchor: input.anchor,
      text: input.text,
      status: "pending",
      createdAt: this.now(),
    };
    store.state.comments.push(comment);
    await store.save();
    return cloneComment(comment);
  }

  /** Edit a pending comment's text and/or anchor. Archived comments are frozen. */
  async updateComment(
    projectPath: string,
    id: string,
    patch: UpdateReviewCommentInput,
  ): Promise<ReviewComment | null> {
    const store = await this.getStore(projectPath);
    const comment = store.state.comments.find((c) => c.id === id);
    if (comment?.status !== "pending") return null;
    if (patch.text !== undefined) comment.text = patch.text;
    if (patch.anchor !== undefined) comment.anchor = patch.anchor;
    await store.save();
    return cloneComment(comment);
  }

  /** Discard a pending comment. Archived comments are kept for history. */
  async deleteComment(projectPath: string, id: string): Promise<boolean> {
    const store = await this.getStore(projectPath);
    const idx = store.state.comments.findIndex(
      (c) => c.id === id && c.status === "pending",
    );
    if (idx === -1) return false;
    store.state.comments.splice(idx, 1);
    await store.save();
    return true;
  }

  /**
   * Consume the named pending comments into a batch: mark them archived,
   * stamp the batch + target session, and record the batch. Only currently
   * pending comments are consumed; unknown or already-archived ids are
   * ignored. Returns the recorded batch.
   */
  async archiveComments(
    projectPath: string,
    input: ArchiveReviewCommentsInput,
  ): Promise<ReviewBatch> {
    const store = await this.getStore(projectPath);
    const submittedAt = input.submittedAt ?? this.now();
    const batchId = this.newId();
    const requested = new Set(input.commentIds);
    const consumed: string[] = [];

    for (const comment of store.state.comments) {
      if (comment.status === "pending" && requested.has(comment.id)) {
        comment.status = "archived";
        comment.archivedAt = submittedAt;
        comment.batchId = batchId;
        comment.targetSessionId = input.targetSessionId;
        consumed.push(comment.id);
      }
    }

    const batch: ReviewBatch = {
      id: batchId,
      submittedAt,
      targetSessionId: input.targetSessionId,
      commentIds: consumed,
    };
    store.state.batches.push(batch);
    await store.save();
    return { ...batch, commentIds: [...batch.commentIds] };
  }

  /** The on-disk path of a project's drafts file (for tests/diagnostics). */
  filePathFor(projectPath: string): string {
    return path.join(projectPath, YEP_DIR, REVIEW_COMMENTS_FILENAME);
  }

  /** Drop cached state (tests: simulate a fresh service / server restart). */
  reset(): void {
    this.stores.clear();
  }

  private async getStore(projectPath: string): Promise<ProjectStore> {
    let store = this.stores.get(projectPath);
    if (!store) {
      const created: ProjectStore = {
        state: emptyReviewCommentsFile(),
        loadPromise: null,
        loaded: false,
        dirEnsured: false,
        save: () => Promise.resolve(),
      };
      created.save = createCoalescingSaver(() =>
        this.doSave(projectPath, created),
      );
      this.stores.set(projectPath, created);
      store = created;
    }
    if (!store.loaded) {
      if (!store.loadPromise) {
        store.loadPromise = this.load(projectPath, store);
      }
      await store.loadPromise;
    }
    return store;
  }

  private async load(projectPath: string, store: ProjectStore): Promise<void> {
    try {
      const content = await fs.readFile(this.filePathFor(projectPath), "utf-8");
      store.state = parseReviewCommentsFile(JSON.parse(content));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        // Corrupt/unreadable file: degrade to an empty store rather than
        // wedging the review surface. A JSON.parse throw lands here too.
        console.warn(
          `[ReviewCommentService] Failed to load drafts for ${projectPath}, starting fresh:`,
          error,
        );
      }
      store.state = emptyReviewCommentsFile();
    }
    store.loaded = true;
  }

  private async doSave(
    projectPath: string,
    store: ProjectStore,
  ): Promise<void> {
    if (!store.dirEnsured) {
      // Creates `.yep/`, git-excluding it by default on first creation.
      await ensureManagedProjectDir(projectPath, YEP_DIR);
      store.dirEnsured = true;
    }
    const filePath = this.filePathFor(projectPath);
    const tmpPath = `${filePath}.${randomUUID()}.tmp`;
    const content = JSON.stringify(store.state, null, 2);
    await fs.writeFile(tmpPath, content, "utf-8");
    await fs.rename(tmpPath, filePath);
  }
}

function cloneComment(comment: ReviewComment): ReviewComment {
  return { ...comment, anchor: { ...comment.anchor } };
}

function cloneFile(file: ReviewCommentsFile): ReviewCommentsFile {
  return {
    version: file.version,
    comments: file.comments.map(cloneComment),
    batches: file.batches.map((b) => ({ ...b, commentIds: [...b.commentIds] })),
  };
}
