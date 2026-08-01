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
  MAX_REVIEW_SUBMISSION_NAME_LENGTH,
  REVIEW_COMMENTS_FILE_VERSION,
  REVIEW_SUBMISSION_REQUEST_VERSION,
  type ReviewBatch,
  type ReviewCapture,
  type ReviewComment,
  type ReviewCommentAnchor,
  type ReviewCommentsFile,
  type ReviewEntryRef,
  type ReviewReviewerEntry,
  type ReviewSourceProjection,
  type ReviewStoreFile,
  type ReviewSubmissionRelocation,
  type ReviewSubmissionRequest,
  type ReviewSubmissionSummary,
  emptyReviewStoreFile,
  parseReviewStoreFile,
  parseReviewSubmissionRequest,
  projectLegacyReviewComments,
} from "@yep-anywhere/shared";
import { createCoalescingSaver } from "../lib/coalescingSaver.js";
import { HttpError } from "../middleware/error-handler.js";
import { ensureManagedProjectDir } from "../projects/managedProjectDir.js";

const YEP_DIR = ".yep";
const REVIEW_COMMENTS_FILENAME = "review-comments.json";
const SOURCE_REVIEW_DIR = "source-review";
const REQUEST_FILENAME = "request.json";

interface ProjectStore {
  state: ReviewStoreFile;
  loadPromise: Promise<void> | null;
  loaded: boolean;
  dirEnsured: boolean;
  save: () => Promise<void>;
  mutationTail: Promise<void>;
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

export interface AddReviewFollowUpInput {
  anchor: ReviewCommentAnchor;
  text: string;
}

export interface ArchiveReviewCommentsInput {
  commentIds: string[];
  targetSessionId: string;
  /** Defaults to now; injectable for deterministic tests. */
  submittedAt?: string;
}

export interface PrepareReviewSubmissionInput {
  submissionId: string;
  name?: string;
  commentIds: string[];
  requestedTarget: "new" | string;
  relocations: Map<string, ReviewSubmissionRelocation>;
}

export interface AcceptReviewSubmissionInput {
  submissionId: string;
  targetSessionId?: string;
  responseTurnLimit: number;
  deliveryStatus: "queued" | "delivered";
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
    return (
      (await this.listComments(projectPath)).find((item) => item.id === id) ??
      null
    );
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
    const draftIndex = store.state.drafts.findIndex(
      (ref) => ref.entryId === id,
    );
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

  /**
   * Reserve draft entries and freeze their immutable request manifest. Existing
   * manifests bind an id to the same request, so a retry cannot retarget it.
   */
  async prepareSubmission(
    projectPath: string,
    input: PrepareReviewSubmissionInput,
  ): Promise<ReviewSubmissionRequest> {
    validateSubmissionInput(input);
    return this.withMutation(projectPath, async (store) => {
      const existingRequest = await this.readSubmissionRequest(
        projectPath,
        input.submissionId,
      );
      const existingSummary = store.state.submissions.find(
        (item) => item.id === input.submissionId,
      );

      if (existingRequest) {
        assertSameSubmissionRequest(existingRequest, input);
        if (!existingSummary) {
          this.reserveRequestEntries(store.state, existingRequest);
          store.state.submissions.push(summaryFromRequest(existingRequest));
          await store.save();
        }
        return cloneSubmissionRequest(existingRequest);
      }
      if (existingSummary) {
        // Startup recovery rolls back this incomplete durable reservation. The
        // caller can immediately prepare the same id again from still-live drafts.
        store.state.submissions = store.state.submissions.filter(
          (item) => item.id !== input.submissionId,
        );
        await store.save();
      }

      const requested = new Set(input.commentIds);
      const reservedElsewhere = new Set(
        store.state.submissions
          .filter((item) => item.status === "prepared")
          .flatMap((item) => item.entryRefs.map((ref) => entryRefKey(ref))),
      );
      const refs = store.state.drafts.filter(
        (ref) =>
          requested.has(ref.entryId) &&
          !reservedElsewhere.has(entryRefKey(ref)),
      );
      if (refs.length !== requested.size) {
        throw new HttpError(
          409,
          "One or more review comments are no longer pending or are being submitted",
        );
      }
      const submittedAt = this.now();
      const request: ReviewSubmissionRequest = {
        version: REVIEW_SUBMISSION_REQUEST_VERSION,
        submissionId: input.submissionId,
        submittedAt,
        requestedTarget: input.requestedTarget,
        entries: refs.map((ref) => {
          const found = findEntry(store.state, ref);
          const relocation = input.relocations.get(ref.entryId);
          if (!found || !relocation) {
            throw new HttpError(
              409,
              "Review comment changed before submission",
            );
          }
          return {
            ...ref,
            text: found.entry.text,
            anchor: cloneAnchor(found.entry.anchor),
            capture: cloneCapture(found.entry.capture),
            relocation: cloneRelocation(relocation),
          };
        }),
        ...(input.name ? { name: input.name } : {}),
      };
      store.state.submissions.push(summaryFromRequest(request));
      await store.save();
      try {
        await this.writeSubmissionRequest(projectPath, request);
      } catch (error) {
        store.state.submissions = store.state.submissions.filter(
          (item) => item.id !== input.submissionId,
        );
        await store.save();
        throw error;
      }
      return cloneSubmissionRequest(request);
    });
  }

  /** Archive a prepared submission after the launcher accepted its keyed turn. */
  async acceptSubmission(
    projectPath: string,
    input: AcceptReviewSubmissionInput,
  ): Promise<ReviewSubmissionSummary | null> {
    return this.withMutation(projectPath, async (store) => {
      const summary = store.state.submissions.find(
        (item) => item.id === input.submissionId,
      );
      if (!summary) return null;
      if (summary.status === "accepted") {
        let changed = false;
        if (
          input.deliveryStatus === "delivered" &&
          summary.deliveryStatus !== "delivered"
        ) {
          summary.deliveryStatus = "delivered";
          changed = true;
        }
        if (
          input.targetSessionId &&
          summary.targetSessionId !== input.targetSessionId
        ) {
          summary.targetSessionId = input.targetSessionId;
          changed = true;
        }
        if (changed) await store.save();
        return cloneSubmission(summary);
      }
      const request = await this.readSubmissionRequest(
        projectPath,
        input.submissionId,
      );
      if (!request) {
        throw new HttpError(409, "Submission request manifest is missing");
      }
      summary.status = "accepted";
      summary.deliveryStatus = input.deliveryStatus;
      summary.responseTurnsObserved = 0;
      summary.responseTurnLimit = input.responseTurnLimit;
      if (input.targetSessionId)
        summary.targetSessionId = input.targetSessionId;
      const acceptedKeys = new Set(summary.entryRefs.map(entryRefKey));
      store.state.drafts = store.state.drafts.filter(
        (ref) => !acceptedKeys.has(entryRefKey(ref)),
      );
      for (const ref of summary.entryRefs) {
        const found = findEntry(store.state, ref);
        if (!found) continue;
        found.entry.submittedAt = summary.submittedAt;
        found.entry.submissionId = summary.id;
      }
      await store.save();
      return cloneSubmission(summary);
    });
  }

  /** Release a reservation after the launcher rejects before acceptance. */
  async releaseSubmission(
    projectPath: string,
    submissionId: string,
  ): Promise<boolean> {
    return this.withMutation(projectPath, async (store) => {
      const summary = store.state.submissions.find(
        (item) => item.id === submissionId,
      );
      if (summary?.status !== "prepared") return false;
      store.state.submissions = store.state.submissions.filter(
        (item) => item.id !== submissionId,
      );
      await store.save();
      return true;
    });
  }

  /** Attach the eventual canonical YA id to a previously queued submission. */
  async associateSubmissionSession(
    projectPath: string,
    submissionId: string,
    sessionId: string,
  ): Promise<ReviewSubmissionSummary | null> {
    return this.withMutation(projectPath, async (store) => {
      const summary = store.state.submissions.find(
        (item) => item.id === submissionId,
      );
      if (!summary || summary.status === "legacy") return null;
      summary.targetSessionId = sessionId;
      await store.save();
      return cloneSubmission(summary);
    });
  }

  /** Create a fresh active entry at an existing discussion site. */
  async addFollowUp(
    projectPath: string,
    siteId: string,
    input: AddReviewFollowUpInput,
  ): Promise<ReviewReviewerEntry | null> {
    const store = await this.getStore(projectPath);
    if (store.state.drafts.length >= MAX_REVIEW_COMMENTS) {
      throw new HttpError(
        413,
        `Review comment limit reached (${MAX_REVIEW_COMMENTS}); submit or delete drafts first.`,
      );
    }
    const site = store.state.sites.find((item) => item.id === siteId);
    if (!site) return null;
    if (store.state.drafts.some((draft) => draft.siteId === siteId)) {
      throw new HttpError(409, "This review site already has an active draft");
    }
    const entryId = this.newId();
    const entry: ReviewReviewerEntry = {
      id: entryId,
      anchor: cloneAnchor(input.anchor),
      text: input.text,
      capture: await this.capture(projectPath, input.anchor),
      createdAt: this.now(),
    };
    site.entries.push(entry);
    site.path = input.anchor.path;
    delete site.resolvedAt;
    store.state.drafts.push({ siteId, entryId });
    await store.save();
    return cloneReviewerEntry(entry);
  }

  async resolveSite(projectPath: string, siteId: string): Promise<boolean> {
    const store = await this.getStore(projectPath);
    const site = store.state.sites.find((item) => item.id === siteId);
    if (!site) return false;
    site.resolvedAt = this.now();
    await store.save();
    return true;
  }

  async acknowledgeSubmission(
    projectPath: string,
    submissionId: string,
  ): Promise<ReviewSubmissionSummary | null> {
    const store = await this.getStore(projectPath);
    const submission = store.state.submissions.find(
      (item) => item.id === submissionId,
    );
    if (!submission) return null;
    submission.acknowledgedRevision = submission.responseRevision;
    await store.save();
    return cloneSubmission(submission);
  }

  filePathFor(projectPath: string): string {
    return path.join(projectPath, YEP_DIR, REVIEW_COMMENTS_FILENAME);
  }

  submissionDirectoryFor(projectPath: string, submissionId: string): string {
    validateSubmissionId(submissionId);
    return path.join(projectPath, YEP_DIR, SOURCE_REVIEW_DIR, submissionId);
  }

  requestPathFor(projectPath: string, submissionId: string): string {
    return path.join(
      this.submissionDirectoryFor(projectPath, submissionId),
      REQUEST_FILENAME,
    );
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

  private reserveRequestEntries(
    state: ReviewStoreFile,
    request: ReviewSubmissionRequest,
  ): void {
    const draftKeys = new Set(state.drafts.map(entryRefKey));
    for (const entry of request.entries) {
      if (!draftKeys.has(entryRefKey(entry))) {
        throw new HttpError(409, "Submission entries are no longer pending");
      }
    }
  }

  private async readSubmissionRequest(
    projectPath: string,
    submissionId: string,
  ): Promise<ReviewSubmissionRequest | null> {
    try {
      const raw = await fs.readFile(
        this.requestPathFor(projectPath, submissionId),
        "utf-8",
      );
      const parsed = parseReviewSubmissionRequest(JSON.parse(raw));
      if (!parsed || parsed.submissionId !== submissionId) {
        throw new HttpError(409, "Submission request manifest is invalid");
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private async writeSubmissionRequest(
    projectPath: string,
    request: ReviewSubmissionRequest,
  ): Promise<void> {
    await ensureManagedProjectDir(projectPath, YEP_DIR);
    const directory = this.submissionDirectoryFor(
      projectPath,
      request.submissionId,
    );
    await fs.mkdir(directory, { recursive: true });
    const file = await fs.open(
      this.requestPathFor(projectPath, request.submissionId),
      "wx",
    );
    try {
      await file.writeFile(`${JSON.stringify(request, null, 2)}\n`, "utf-8");
      await file.sync();
    } finally {
      await file.close();
    }
    const directoryHandle = await fs.open(directory, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
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
        mutationTail: Promise.resolve(),
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

  private async withMutation<T>(
    projectPath: string,
    mutate: (store: ProjectStore) => Promise<T>,
  ): Promise<T> {
    const store = await this.getStore(projectPath);
    const run = store.mutationTail.then(
      () => mutate(store),
      () => mutate(store),
    );
    store.mutationTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async load(projectPath: string, store: ProjectStore): Promise<void> {
    let needsSave = false;
    try {
      const content = await fs.readFile(this.filePathFor(projectPath), "utf-8");
      const parsed = JSON.parse(content) as { version?: unknown };
      needsSave = parsed.version === REVIEW_COMMENTS_FILE_VERSION;
      store.state = parseReviewStoreFile(parsed);
      const recovered: ReviewSubmissionSummary[] = [];
      for (const submission of store.state.submissions) {
        if (submission.status !== "prepared") {
          recovered.push(submission);
          continue;
        }
        try {
          await fs.access(this.requestPathFor(projectPath, submission.id));
          recovered.push(submission);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          needsSave = true;
        }
      }
      store.state.submissions = recovered;
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
    if (needsSave) await store.save();
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
    const file = await fs.open(tmpPath, "wx");
    try {
      await file.writeFile(content, "utf-8");
      await file.sync();
    } finally {
      await file.close();
    }
    await fs.rename(tmpPath, filePath);
    const directory = await fs.open(path.dirname(filePath), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
}

function findEntry(store: ReviewStoreFile, ref: ReviewEntryRef) {
  const site = store.sites.find((item) => item.id === ref.siteId);
  const entry = site?.entries.find((item) => item.id === ref.entryId);
  return site && entry ? { site, entry } : null;
}

function validateSubmissionId(submissionId: string): void {
  if (
    submissionId.length === 0 ||
    submissionId.length > 128 ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(submissionId)
  ) {
    throw new HttpError(400, "Invalid review submission id");
  }
}

function validateSubmissionInput(input: PrepareReviewSubmissionInput): void {
  validateSubmissionId(input.submissionId);
  if (
    input.name !== undefined &&
    (input.name.trim().length === 0 ||
      input.name.length > MAX_REVIEW_SUBMISSION_NAME_LENGTH)
  ) {
    throw new HttpError(400, "Invalid review submission name");
  }
}

function entryRefKey(ref: ReviewEntryRef): string {
  return `${ref.siteId}\0${ref.entryId}`;
}

function summaryFromRequest(
  request: ReviewSubmissionRequest,
): ReviewSubmissionSummary {
  return {
    id: request.submissionId,
    submittedAt: request.submittedAt,
    requestedTarget: request.requestedTarget,
    entryRefs: request.entries.map(({ siteId, entryId }) => ({
      siteId,
      entryId,
    })),
    status: "prepared",
    responseRevision: 0,
    acknowledgedRevision: 0,
    ...(request.name ? { name: request.name } : {}),
  };
}

function assertSameSubmissionRequest(
  request: ReviewSubmissionRequest,
  input: PrepareReviewSubmissionInput,
): void {
  const requestedIds = [...new Set(input.commentIds)].sort();
  const frozenIds = request.entries.map((entry) => entry.entryId).sort();
  if (
    request.requestedTarget !== input.requestedTarget ||
    (request.name ?? "") !== (input.name ?? "") ||
    JSON.stringify(requestedIds) !== JSON.stringify(frozenIds)
  ) {
    throw new HttpError(
      409,
      "Submission id is already bound to another request",
    );
  }
}

function cloneCapture(capture: ReviewCapture): ReviewCapture {
  return capture.status === "captured"
    ? { ...capture, projection: { ...capture.projection } }
    : { status: "legacy-missing" };
}

function cloneRelocation(
  relocation: ReviewSubmissionRelocation,
): ReviewSubmissionRelocation {
  return { ...relocation };
}

function cloneSubmissionRequest(
  request: ReviewSubmissionRequest,
): ReviewSubmissionRequest {
  return {
    ...request,
    entries: request.entries.map((entry) => ({
      ...entry,
      anchor: cloneAnchor(entry.anchor),
      capture: cloneCapture(entry.capture),
      relocation: cloneRelocation(entry.relocation),
    })),
  };
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
    ...(!pending && entry.submittedAt ? { archivedAt: entry.submittedAt } : {}),
    ...(!pending && entry.submissionId ? { batchId: entry.submissionId } : {}),
  };
}

function cloneReviewerEntry(entry: ReviewReviewerEntry): ReviewReviewerEntry {
  return {
    ...entry,
    anchor: cloneAnchor(entry.anchor),
    capture:
      entry.capture.status === "captured"
        ? {
            ...entry.capture,
            projection: { ...entry.capture.projection },
          }
        : { status: "legacy-missing" },
  };
}

function cloneSubmission(
  submission: ReviewSubmissionSummary,
): ReviewSubmissionSummary {
  return {
    ...submission,
    entryRefs: submission.entryRefs.map((ref) => ({ ...ref })),
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
      entries: site.entries.map(cloneReviewerEntry),
      outcomes: site.outcomes.map((outcome) => ({ ...outcome })),
    })),
    drafts: file.drafts.map((draft) => ({ ...draft })),
    submissions: file.submissions.map(cloneSubmission),
  };
}
