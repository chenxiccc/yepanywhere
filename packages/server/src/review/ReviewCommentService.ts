/**
 * ReviewCommentService — canonical source-review sites, entries, and drafts.
 *
 * Disk state is version 2 even though the established comments endpoint still
 * receives a version-1 projection. Version-1 files migrate before any later
 * write, preserving all comments and batches while marking their unavailable
 * comment-time source captures honestly.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  MAX_REVIEW_COMMENTS,
  REVIEW_COMMENTS_FILE_VERSION,
  type ReviewBatch,
  type ReviewCapture,
  type ReviewComment,
  type ReviewCommentAnchor,
  type ReviewCommentsFile,
  type ReviewEntryRef,
  type ReviewReviewerEntry,
  type ReviewSourceProjection,
  type ReviewStoreFile,
  type ReviewSubmissionSummary,
  emptyReviewStoreFile,
  parseReviewStoreFile,
  projectLegacyReviewComments,
} from "@yep-anywhere/shared";
import { createCoalescingSaver } from "../lib/coalescingSaver.js";
import { HttpError } from "../middleware/error-handler.js";
import { ensureManagedProjectDir } from "../projects/managedProjectDir.js";

const YEP_DIR = ".yep";
const REVIEW_COMMENTS_FILENAME = "review-comments.json";

interface ProjectStore {
  state: ReviewStoreFile;
  loadPromise: Promise<void> | null;
  loaded: boolean;
  dirEnsured: boolean;
  save: () => Promise<void>;
}

export interface ReviewCaptureWriter {
  capture(
    projectPath: string,
    projection: ReviewSourceProjection,
  ): Promise<ReviewCapture>;
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

/** Deps let tests stub the clock, ids, and git capture boundary. */
export interface ReviewCommentServiceOptions {
  now?: () => string;
  newId?: () => string;
  captureWriter?: ReviewCaptureWriter;
}

export class ReviewCommentService {
  private stores = new Map<string, ProjectStore>();
  private now: () => string;
  private newId: () => string;
  private captureWriter?: ReviewCaptureWriter;

  constructor(options: ReviewCommentServiceOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.newId = options.newId ?? (() => randomUUID());
    this.captureWriter = options.captureWriter;
  }

  /** Stable version-1 projection for established clients. */
  async getFile(projectPath: string): Promise<ReviewCommentsFile> {
    const store = await this.getStore(projectPath);
    return cloneLegacyFile(projectLegacyReviewComments(store.state));
  }

  /** Canonical site/entry/submission state for new routes. */
  async getStoreFile(projectPath: string): Promise<ReviewStoreFile> {
    const store = await this.getStore(projectPath);
    return cloneStoreFile(store.state);
  }

  async listComments(projectPath: string): Promise<ReviewComment[]> {
    return (await this.getFile(projectPath)).comments;
  }

  async listPending(projectPath: string): Promise<ReviewComment[]> {
    return (await this.listComments(projectPath)).filter(
      (comment) => comment.status === "pending",
    );
  }

  async getComment(
    projectPath: string,
    id: string,
  ): Promise<ReviewComment | null> {
    return (await this.listComments(projectPath)).find((item) => item.id === id) ?? null;
  }

  async addComment(
    projectPath: string,
    input: AddReviewCommentInput,
  ): Promise<ReviewComment> {
    const store = await this.getStore(projectPath);
    if (store.state.drafts.length >= MAX_REVIEW_COMMENTS) {
      throw new HttpError(
        413,
        `Review comment limit reached (${MAX_REVIEW_COMMENTS}); submit or delete drafts first.`,
      );
    }
    const entryId = this.newId();
    const siteId = `site-${entryId}`;
    const createdAt = this.now();
    const entry: ReviewReviewerEntry = {
      id: entryId,
      anchor: cloneAnchor(input.anchor),
      text: input.text,
      capture: await this.capture(projectPath, input.anchor),
      createdAt,
    };
    store.state.sites.push({
      id: siteId,
      path: input.anchor.path,
      createdAt,
      entries: [entry],
      outcomes: [],
    });
    store.state.drafts.push({ siteId, entryId });
    await store.save();
    return canonicalEntryToComment(entry, true);
  }

  /** Edit an active draft. Submitted reviewer entries are immutable. */
  async updateComment(
    projectPath: string,
    id: string,
    patch: UpdateReviewCommentInput,
  ): Promise<ReviewComment | null> {
    const store = await this.getStore(projectPath);
    const found = findDraftEntry(store.state, id);
    if (!found) return null;
    const nextCapture = patch.anchor
      ? await this.capture(projectPath, patch.anchor)
      : undefined;
    if (patch.text !== undefined) found.entry.text = patch.text;
    if (patch.anchor !== undefined && nextCapture) {
      found.entry.anchor = cloneAnchor(patch.anchor);
      found.entry.capture = nextCapture;
      found.site.path = patch.anchor.path;
    }
    await store.save();
    return canonicalEntryToComment(found.entry, true);
  }

  /** Discard an active draft. Historical submitted entries are retained. */
  async deleteComment(projectPath: string, id: string): Promise<boolean> {
    const store = await this.getStore(projectPath);
    const draftIndex = store.state.drafts.findIndex((ref) => ref.entryId === id);
    if (draftIndex === -1) return false;
    const [draft] = store.state.drafts.splice(draftIndex, 1);
    const site = store.state.sites.find((item) => item.id === draft?.siteId);
    if (site) {
      site.entries = site.entries.filter((entry) => entry.id !== id);
      if (site.entries.length === 0 && site.outcomes.length === 0) {
        store.state.sites = store.state.sites.filter(
          (item) => item.id !== site.id,
        );
      }
    }
    await store.save();
    return true;
  }

  /**
   * Compatibility archive path. New transactional acceptance builds the same
   * canonical summary with a client-supplied id in the next stage.
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
    const entryRefs: ReviewEntryRef[] = [];

    for (let index = store.state.drafts.length - 1; index >= 0; index--) {
      const ref = store.state.drafts[index];
      if (!ref || !requested.has(ref.entryId)) continue;
      const found = findEntry(store.state, ref);
      if (!found) continue;
      found.entry.submittedAt = submittedAt;
      found.entry.submissionId = batchId;
      consumed.unshift(ref.entryId);
      entryRefs.unshift({ ...ref });
      store.state.drafts.splice(index, 1);
    }

    const summary: ReviewSubmissionSummary = {
      id: batchId,
      submittedAt,
      requestedTarget: input.targetSessionId,
      targetSessionId: input.targetSessionId,
      entryRefs,
      status: "legacy",
      responseRevision: 0,
      acknowledgedRevision: 0,
    };
    store.state.submissions.push(summary);
    await store.save();
    return {
      id: batchId,
      submittedAt,
      targetSessionId: input.targetSessionId,
      commentIds: consumed,
    };
  }

  filePathFor(projectPath: string): string {
    return path.join(projectPath, YEP_DIR, REVIEW_COMMENTS_FILENAME);
  }

  reset(): void {
    this.stores.clear();
  }

  private async capture(
    projectPath: string,
    anchor: ReviewCommentAnchor,
  ): Promise<ReviewCapture> {
    return anchor.projection && this.captureWriter
      ? this.captureWriter.capture(projectPath, anchor.projection)
      : { status: "legacy-missing" };
  }

  private async getStore(projectPath: string): Promise<ProjectStore> {
    let store = this.stores.get(projectPath);
    if (!store) {
      const created: ProjectStore = {
        state: emptyReviewStoreFile(),
        loadPromise: null,
        loaded: false,
        dirEnsured: false,
        save: () => Promise.resolve(),
      };
      created.save = createCoalescingSaver(() =>
        this.doSave(projectPath, created),
      ).save;
      this.stores.set(projectPath, created);
      store = created;
    }
    if (!store.loaded) {
      if (!store.loadPromise) store.loadPromise = this.load(projectPath, store);
      await store.loadPromise;
    }
    return store;
  }

  private async load(projectPath: string, store: ProjectStore): Promise<void> {
    let migrated = false;
    try {
      const content = await fs.readFile(this.filePathFor(projectPath), "utf-8");
      const parsed = JSON.parse(content) as { version?: unknown };
      migrated = parsed.version === REVIEW_COMMENTS_FILE_VERSION;
      store.state = parseReviewStoreFile(parsed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(
          `[ReviewCommentService] Failed to load drafts for ${projectPath}, starting fresh:`,
          error,
        );
      }
      store.state = emptyReviewStoreFile();
    }
    store.loaded = true;
    if (migrated) await store.save();
  }

  private async doSave(
    projectPath: string,
    store: ProjectStore,
  ): Promise<void> {
    if (!store.dirEnsured) {
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

function findEntry(store: ReviewStoreFile, ref: ReviewEntryRef) {
  const site = store.sites.find((item) => item.id === ref.siteId);
  const entry = site?.entries.find((item) => item.id === ref.entryId);
  return site && entry ? { site, entry } : null;
}

function findDraftEntry(store: ReviewStoreFile, entryId: string) {
  const ref = store.drafts.find((item) => item.entryId === entryId);
  return ref ? findEntry(store, ref) : null;
}

function cloneAnchor(anchor: ReviewCommentAnchor): ReviewCommentAnchor {
  return {
    ...anchor,
    revision: { ...anchor.revision },
    ...(anchor.projection ? { projection: { ...anchor.projection } } : {}),
  };
}

function canonicalEntryToComment(
  entry: ReviewReviewerEntry,
  pending: boolean,
): ReviewComment {
  return {
    id: entry.id,
    anchor: cloneAnchor(entry.anchor),
    text: entry.text,
    status: pending ? "pending" : "archived",
    createdAt: entry.createdAt,
    ...(!pending && entry.submittedAt
      ? { archivedAt: entry.submittedAt }
      : {}),
    ...(!pending && entry.submissionId ? { batchId: entry.submissionId } : {}),
  };
}

function cloneLegacyFile(file: ReviewCommentsFile): ReviewCommentsFile {
  return {
    version: file.version,
    comments: file.comments.map((comment) => ({
      ...comment,
      anchor: cloneAnchor(comment.anchor),
    })),
    batches: file.batches.map((batch) => ({
      ...batch,
      commentIds: [...batch.commentIds],
    })),
  };
}

function cloneStoreFile(file: ReviewStoreFile): ReviewStoreFile {
  return {
    version: file.version,
    sites: file.sites.map((site) => ({
      ...site,
      entries: site.entries.map((entry) => ({
        ...entry,
        anchor: cloneAnchor(entry.anchor),
        capture:
          entry.capture.status === "captured"
            ? {
                ...entry.capture,
                projection: { ...entry.capture.projection },
              }
            : { status: "legacy-missing" },
      })),
      outcomes: site.outcomes.map((outcome) => ({ ...outcome })),
    })),
    drafts: file.drafts.map((draft) => ({ ...draft })),
    submissions: file.submissions.map((submission) => ({
      ...submission,
      entryRefs: submission.entryRefs.map((ref) => ({ ...ref })),
    })),
  };
}
