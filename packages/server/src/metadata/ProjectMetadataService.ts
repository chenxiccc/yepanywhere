/**
 * ProjectMetadataService manages custom project metadata.
 * This enables adding new projects before any Claude sessions exist and
 * hiding projects discovered from session logs.
 *
 * State is persisted to a JSON file for durability across server restarts.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  allocateProjectCodeName,
  MAX_HEARTBEAT_TURN_TEXT_LENGTH,
  MAX_PROJECT_HEARTBEAT_RECENT_TEXTS,
  normalizeProjectCodeName,
  projectCodeNameKey,
  projectCodeNamePrefixesProjectName,
  type ProjectCodeNameAssignment,
  type UpdateProjectSessionDefaultsRequest,
  type UrlProjectId,
} from "@yep-anywhere/shared";
import {
  canonicalizeProjectPath,
  decodeProjectId,
  encodeProjectId,
  getProjectIdentityKey,
} from "../projects/paths.js";
import { createCoalescingSaver } from "../lib/coalescingSaver.js";

export interface ProjectMetadata {
  /** The absolute path to the project directory */
  path: string;
  /** When the project was added */
  addedAt: string;
}

export interface HiddenProjectMetadata {
  /** The absolute path to the project directory */
  path: string;
  /** When the project was hidden from YA project lists */
  hiddenAt: string;
}

export interface ProjectSessionDefaultsMetadata {
  heartbeatTurnsAfterMinutes?: number;
  heartbeatTurnText?: string;
  recentHeartbeatTurnTexts?: string[];
  updatedAt: string;
}

export interface ProjectCodeNameMetadata {
  codeName: string;
  projectName: string;
  source: "generated" | "manual";
  updatedAt: string;
}

export interface ProjectMetadataState {
  /** Map of projectId -> metadata */
  projects: Record<string, ProjectMetadata>;
  /** Map of projectId -> hidden project metadata */
  hiddenProjects?: Record<string, HiddenProjectMetadata>;
  /** Project-scoped defaults used to initialize new session metadata. */
  projectSessionDefaults?: Record<string, ProjectSessionDefaultsMetadata>;
  /** Durable unique labels used in compact project identity surfaces. */
  projectCodeNames?: Record<string, ProjectCodeNameMetadata>;
  /** Schema version for future migrations */
  version: number;
}

const CURRENT_VERSION = 4;

export interface ProjectMetadataServiceOptions {
  /** Directory to store metadata state (defaults to ~/.yep-anywhere) */
  dataDir?: string;
}

export class ProjectMetadataService {
  private state: ProjectMetadataState;
  private dataDir: string;
  private filePath: string;
  private save = createCoalescingSaver(() => this.doSave()).save;

  constructor(options: ProjectMetadataServiceOptions = {}) {
    this.dataDir =
      options.dataDir ??
      path.join(
        process.env.HOME ?? process.env.USERPROFILE ?? ".",
        ".yep-anywhere",
      );
    this.filePath = path.join(this.dataDir, "project-metadata.json");
    this.state = {
      projects: {},
      hiddenProjects: {},
      projectSessionDefaults: {},
      projectCodeNames: {},
      version: CURRENT_VERSION,
    };
  }

  /**
   * Initialize the service by loading state from disk.
   * Creates the data directory and file if they don't exist.
   */
  async initialize(): Promise<void> {
    console.log(`[ProjectMetadataService] Initializing from: ${this.filePath}`);
    try {
      // Ensure data directory exists
      await fs.mkdir(this.dataDir, { recursive: true });

      // Try to load existing state
      const content = await fs.readFile(this.filePath, "utf-8");
      const parsed = JSON.parse(content) as ProjectMetadataState;
      console.log(
        `[ProjectMetadataService] Loaded ${Object.keys(parsed.projects).length} projects from disk`,
      );

      // Validate and migrate if needed
      if (parsed.version === CURRENT_VERSION) {
        this.state = this.normalizeState(parsed);
      } else {
        // Future: handle migrations here
        this.state = this.normalizeState({
          projects: parsed.projects ?? {},
          hiddenProjects: parsed.hiddenProjects ?? {},
          projectSessionDefaults: parsed.projectSessionDefaults ?? {},
          projectCodeNames: parsed.projectCodeNames ?? {},
          version: CURRENT_VERSION,
        });
        await this.save();
      }
    } catch (error) {
      // File doesn't exist or is invalid - start fresh
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(
          "[ProjectMetadataService] Failed to load state, starting fresh:",
          error,
        );
      }
      this.state = {
        projects: {},
        hiddenProjects: {},
        projectSessionDefaults: {},
        projectCodeNames: {},
        version: CURRENT_VERSION,
      };
    }
  }

  /**
   * Get metadata for a project.
   */
  getMetadata(projectId: string): ProjectMetadata | undefined {
    return this.state.projects[projectId];
  }

  /**
   * Get all added projects.
   */
  getAllProjects(): Record<string, ProjectMetadata> {
    return { ...this.state.projects };
  }

  /**
   * Get all hidden projects.
   */
  getAllHiddenProjects(): Record<string, HiddenProjectMetadata> {
    return { ...(this.state.hiddenProjects ?? {}) };
  }

  getProjectSessionDefaults(
    projectId: string,
  ): ProjectSessionDefaultsMetadata | undefined {
    const value =
      this.state.projectSessionDefaults?.[this.canonicalProjectId(projectId)];
    return value
      ? {
          ...value,
          recentHeartbeatTurnTexts: value.recentHeartbeatTurnTexts
            ? [...value.recentHeartbeatTurnTexts]
            : undefined,
        }
      : undefined;
  }

  getProjectCodeName(projectId: string): string | undefined {
    return this.state.projectCodeNames?.[this.canonicalProjectId(projectId)]
      ?.codeName;
  }

  async ensureProjectCodeNames(
    projects: readonly { id: string; name: string }[],
  ): Promise<ProjectCodeNameAssignment[]> {
    const changed = this.ensureProjectCodeNamesInMemory(projects);
    if (changed) await this.save();
    return projects.map((project) => {
      const codeName = this.getProjectCodeName(project.id);
      if (!codeName) {
        throw new Error(
          `Project code-name allocation failed for ${project.id}`,
        );
      }
      return { projectId: project.id, codeName };
    });
  }

  async setProjectCodeName(
    projectId: string,
    requestedCodeName: string,
    projects: readonly { id: string; name: string }[],
  ): Promise<ProjectCodeNameAssignment[]> {
    const codeName = normalizeProjectCodeName(requestedCodeName);
    this.ensureProjectCodeNamesInMemory(projects);

    const canonicalProjectId = this.canonicalProjectId(projectId);
    const project = projects.find(
      (candidate) =>
        this.canonicalProjectId(candidate.id) === canonicalProjectId,
    );
    if (!project) {
      throw new RangeError("Project is not available for code-name editing");
    }

    this.state.projectCodeNames ??= {};
    const records = this.state.projectCodeNames;
    const requestedKey = projectCodeNameKey(codeName);
    const displaced = Object.entries(records)
      .filter(
        ([candidateProjectId, metadata]) =>
          candidateProjectId !== canonicalProjectId &&
          projectCodeNameKey(metadata.codeName) === requestedKey,
      )
      .sort(([left], [right]) => left.localeCompare(right));
    const changingIds = new Set([
      canonicalProjectId,
      ...displaced.map(([candidateProjectId]) => candidateProjectId),
    ]);
    const reserved = new Set(
      Object.entries(records)
        .filter(([candidateProjectId]) => !changingIds.has(candidateProjectId))
        .map(([, metadata]) => metadata.codeName),
    );
    const updatedAt = new Date().toISOString();
    records[canonicalProjectId] = {
      codeName,
      projectName: project.name,
      source: "manual",
      updatedAt,
    };
    reserved.add(codeName);

    const assignments: ProjectCodeNameAssignment[] = [
      { projectId: canonicalProjectId, codeName },
    ];
    for (const [displacedProjectId, metadata] of displaced) {
      const replacement = allocateProjectCodeName(
        metadata.projectName,
        reserved,
        Object.entries(records)
          .filter(
            ([candidateProjectId]) => candidateProjectId !== displacedProjectId,
          )
          .map(([, candidateMetadata]) => candidateMetadata.projectName),
      );
      records[displacedProjectId] = {
        ...metadata,
        codeName: replacement,
        source: "generated",
        updatedAt,
      };
      reserved.add(replacement);
      assignments.push({
        projectId: displacedProjectId,
        codeName: replacement,
      });
    }

    await this.save();
    return assignments;
  }

  async updateProjectSessionDefaults(
    projectId: string,
    updates: UpdateProjectSessionDefaultsRequest,
  ): Promise<ProjectSessionDefaultsMetadata> {
    const canonicalProjectId = this.canonicalProjectId(projectId);
    const current = this.state.projectSessionDefaults?.[canonicalProjectId];
    const next: ProjectSessionDefaultsMetadata = {
      ...current,
      recentHeartbeatTurnTexts: current?.recentHeartbeatTurnTexts
        ? [...current.recentHeartbeatTurnTexts]
        : undefined,
      updatedAt: new Date().toISOString(),
    };

    if (updates.heartbeatTurnsAfterMinutes !== undefined) {
      if (updates.heartbeatTurnsAfterMinutes === null) {
        delete next.heartbeatTurnsAfterMinutes;
      } else if (
        Number.isInteger(updates.heartbeatTurnsAfterMinutes) &&
        updates.heartbeatTurnsAfterMinutes >= 1 &&
        updates.heartbeatTurnsAfterMinutes <= 1440
      ) {
        next.heartbeatTurnsAfterMinutes = updates.heartbeatTurnsAfterMinutes;
      } else {
        throw new RangeError(
          "heartbeatTurnsAfterMinutes must be null or an integer between 1 and 1440",
        );
      }
    }

    if (updates.heartbeatTurnText !== undefined) {
      if (updates.heartbeatTurnText === null) {
        delete next.heartbeatTurnText;
      } else {
        const text = updates.heartbeatTurnText.trim();
        if (!text) {
          throw new RangeError("heartbeatTurnText must not be empty");
        }
        if (text.length > MAX_HEARTBEAT_TURN_TEXT_LENGTH) {
          throw new RangeError(
            `heartbeatTurnText must be at most ${MAX_HEARTBEAT_TURN_TEXT_LENGTH} characters`,
          );
        }
        next.heartbeatTurnText = text;
        next.recentHeartbeatTurnTexts = this.withRecentHeartbeatText(
          next.recentHeartbeatTurnTexts,
          text,
        );
      }
    }

    this.state.projectSessionDefaults ??= {};
    this.state.projectSessionDefaults[canonicalProjectId] = next;
    await this.save();
    return this.getProjectSessionDefaults(
      canonicalProjectId,
    ) as ProjectSessionDefaultsMetadata;
  }

  async recordRecentHeartbeatTurnText(
    projectId: string,
    rawText: string,
  ): Promise<void> {
    const text = rawText.trim().slice(0, MAX_HEARTBEAT_TURN_TEXT_LENGTH);
    if (!text) return;

    const canonicalProjectId = this.canonicalProjectId(projectId);
    const current = this.state.projectSessionDefaults?.[canonicalProjectId];
    const recentHeartbeatTurnTexts = this.withRecentHeartbeatText(
      current?.recentHeartbeatTurnTexts,
      text,
    );
    if (
      current?.recentHeartbeatTurnTexts?.length ===
        recentHeartbeatTurnTexts.length &&
      current.recentHeartbeatTurnTexts.every(
        (value, index) => value === recentHeartbeatTurnTexts[index],
      )
    ) {
      return;
    }

    this.state.projectSessionDefaults ??= {};
    this.state.projectSessionDefaults[canonicalProjectId] = {
      ...current,
      recentHeartbeatTurnTexts,
      updatedAt: new Date().toISOString(),
    };
    await this.save();
  }

  /**
   * Add a project. The projectId should be a UrlProjectId (base64url encoded path).
   */
  async addProject(projectId: string, projectPath: string): Promise<void> {
    const canonicalPath = canonicalizeProjectPath(projectPath);
    const canonicalProjectId = encodeProjectId(canonicalPath);
    if (projectId !== canonicalProjectId) {
      delete this.state.projects[projectId];
      const legacyCodeName = this.state.projectCodeNames?.[projectId];
      if (legacyCodeName) {
        this.state.projectCodeNames ??= {};
        this.state.projectCodeNames[canonicalProjectId] = legacyCodeName;
        delete this.state.projectCodeNames[projectId];
      }
    }
    this.deleteProjectsByIdentity(canonicalPath);
    this.deleteHiddenProjectsByIdentity(canonicalPath);
    this.state.projects[canonicalProjectId] = {
      path: canonicalPath,
      addedAt: new Date().toISOString(),
    };
    await this.save();
  }

  /**
   * Remove a project from the added list.
   */
  async removeProject(projectId: string): Promise<void> {
    const canonicalProjectId = this.canonicalProjectId(projectId);
    const hadCodeName = Boolean(
      this.state.projectCodeNames?.[canonicalProjectId],
    );
    delete this.state.projectCodeNames?.[canonicalProjectId];
    if (this.state.projects[projectId]) {
      const { [projectId]: _, ...rest } = this.state.projects;
      this.state.projects = rest;
      await this.save();
    } else if (hadCodeName) {
      await this.save();
    }
  }

  /**
   * Hide a project from YA's project list without deleting files or session logs.
   */
  async hideProject(projectId: string, projectPath: string): Promise<void> {
    const canonicalPath = canonicalizeProjectPath(projectPath);
    const canonicalProjectId = encodeProjectId(canonicalPath);

    if (projectId !== canonicalProjectId) {
      delete this.state.projects[projectId];
      delete this.state.hiddenProjects?.[projectId];
    }

    this.deleteProjectsByIdentity(canonicalPath);
    this.deleteHiddenProjectsByIdentity(canonicalPath);
    delete this.state.projectCodeNames?.[canonicalProjectId];
    delete this.state.projectCodeNames?.[projectId];
    this.state.hiddenProjects ??= {};
    this.state.hiddenProjects[canonicalProjectId] = {
      path: canonicalPath,
      hiddenAt: new Date().toISOString(),
    };
    await this.save();
  }

  /**
   * Check if a project was manually added.
   */
  isAddedProject(projectId: string): boolean {
    return projectId in this.state.projects;
  }

  /**
   * Check if a project was hidden by the user.
   */
  isHiddenProject(projectId: string): boolean {
    return projectId in (this.state.hiddenProjects ?? {});
  }

  /**
   * Check whether a project path is hidden using the same identity rules as
   * project discovery.
   */
  isHiddenProjectPath(projectPath: string): boolean {
    const targetIdentity = getProjectIdentityKey(projectPath);
    return Object.values(this.state.hiddenProjects ?? {}).some(
      (metadata) => getProjectIdentityKey(metadata.path) === targetIdentity,
    );
  }

  private async doSave(): Promise<void> {
    try {
      const content = JSON.stringify(this.state, null, 2);
      await fs.writeFile(this.filePath, content, "utf-8");
    } catch (error) {
      console.error("[ProjectMetadataService] Failed to save state:", error);
      throw error;
    }
  }

  /**
   * Get the file path for testing purposes.
   */
  getFilePath(): string {
    return this.filePath;
  }

  private normalizeState(state: ProjectMetadataState): ProjectMetadataState {
    const projectsByIdentity = new Map<
      string,
      { projectId: string; metadata: ProjectMetadata }
    >();
    const hiddenProjectsByIdentity = new Map<
      string,
      { projectId: string; metadata: HiddenProjectMetadata }
    >();
    const projectSessionDefaults = new Map<
      string,
      ProjectSessionDefaultsMetadata
    >();
    const projectCodeNames = new Map<string, ProjectCodeNameMetadata>();

    for (const [projectId, metadata] of Object.entries(state.projects ?? {})) {
      const canonicalPath = canonicalizeProjectPath(metadata.path);
      const canonicalProjectId = encodeProjectId(canonicalPath);
      const identity = getProjectIdentityKey(canonicalPath);
      const existing = projectsByIdentity.get(identity);

      if (
        !existing ||
        new Date(metadata.addedAt).getTime() >
          new Date(existing.metadata.addedAt).getTime()
      ) {
        projectsByIdentity.set(identity, {
          projectId: canonicalProjectId,
          metadata: {
            path: canonicalPath,
            addedAt: metadata.addedAt,
          },
        });
      }

      if (projectId !== canonicalProjectId) {
        console.log(
          `[ProjectMetadataService] Canonicalized project metadata key ${projectId} -> ${canonicalProjectId}`,
        );
      }
    }

    for (const [projectId, metadata] of Object.entries(
      state.hiddenProjects ?? {},
    )) {
      const canonicalPath = canonicalizeProjectPath(metadata.path);
      const canonicalProjectId = encodeProjectId(canonicalPath);
      const identity = getProjectIdentityKey(canonicalPath);
      const existing = hiddenProjectsByIdentity.get(identity);

      if (
        !existing ||
        new Date(metadata.hiddenAt).getTime() >
          new Date(existing.metadata.hiddenAt).getTime()
      ) {
        hiddenProjectsByIdentity.set(identity, {
          projectId: canonicalProjectId,
          metadata: {
            path: canonicalPath,
            hiddenAt: metadata.hiddenAt,
          },
        });
      }

      if (projectId !== canonicalProjectId) {
        console.log(
          `[ProjectMetadataService] Canonicalized hidden project metadata key ${projectId} -> ${canonicalProjectId}`,
        );
      }
    }

    for (const hiddenIdentity of hiddenProjectsByIdentity.keys()) {
      projectsByIdentity.delete(hiddenIdentity);
    }

    for (const [projectId, metadata] of Object.entries(
      state.projectSessionDefaults ?? {},
    )) {
      const canonicalProjectId = this.canonicalProjectId(projectId);
      const normalized = this.normalizeProjectSessionDefaults(metadata);
      if (!normalized) continue;
      const existing = projectSessionDefaults.get(canonicalProjectId);
      if (
        !existing ||
        new Date(normalized.updatedAt).getTime() >=
          new Date(existing.updatedAt).getTime()
      ) {
        projectSessionDefaults.set(canonicalProjectId, normalized);
      }
    }

    for (const [projectId, metadata] of Object.entries(
      state.projectCodeNames ?? {},
    )) {
      const normalized = this.normalizeProjectCodeNameMetadata(metadata);
      if (!normalized) continue;
      const canonicalProjectId = this.canonicalProjectId(projectId);
      const existing = projectCodeNames.get(canonicalProjectId);
      if (
        !existing ||
        new Date(normalized.updatedAt).getTime() >=
          new Date(existing.updatedAt).getTime()
      ) {
        projectCodeNames.set(canonicalProjectId, normalized);
      }
    }

    const projects: Record<string, ProjectMetadata> = {};
    for (const { projectId, metadata } of projectsByIdentity.values()) {
      projects[projectId] = metadata;
    }

    const hiddenProjects: Record<string, HiddenProjectMetadata> = {};
    for (const { projectId, metadata } of hiddenProjectsByIdentity.values()) {
      hiddenProjects[projectId] = metadata;
    }

    return {
      projects,
      hiddenProjects,
      projectSessionDefaults: Object.fromEntries(projectSessionDefaults),
      projectCodeNames: Object.fromEntries(projectCodeNames),
      version: CURRENT_VERSION,
    };
  }

  private canonicalProjectId(projectId: string): string {
    try {
      return encodeProjectId(
        canonicalizeProjectPath(decodeProjectId(projectId as UrlProjectId)),
      );
    } catch {
      return projectId;
    }
  }

  private normalizeProjectSessionDefaults(
    metadata: ProjectSessionDefaultsMetadata,
  ): ProjectSessionDefaultsMetadata | undefined {
    if (!metadata || typeof metadata !== "object") return undefined;
    const heartbeatTurnsAfterMinutes =
      Number.isInteger(metadata.heartbeatTurnsAfterMinutes) &&
      (metadata.heartbeatTurnsAfterMinutes ?? 0) >= 1 &&
      (metadata.heartbeatTurnsAfterMinutes ?? 0) <= 1440
        ? metadata.heartbeatTurnsAfterMinutes
        : undefined;
    const heartbeatTurnText =
      typeof metadata.heartbeatTurnText === "string"
        ? metadata.heartbeatTurnText
            .trim()
            .slice(0, MAX_HEARTBEAT_TURN_TEXT_LENGTH) || undefined
        : undefined;
    const recentHeartbeatTurnTexts = Array.isArray(
      metadata.recentHeartbeatTurnTexts,
    )
      ? metadata.recentHeartbeatTurnTexts.reduce<string[]>((recent, value) => {
          if (typeof value !== "string") return recent;
          const text = value.trim().slice(0, MAX_HEARTBEAT_TURN_TEXT_LENGTH);
          if (!text || recent.includes(text)) return recent;
          recent.push(text);
          return recent;
        }, [])
      : [];
    const updatedAt = Number.isFinite(new Date(metadata.updatedAt).getTime())
      ? metadata.updatedAt
      : new Date(0).toISOString();

    return {
      ...(heartbeatTurnsAfterMinutes === undefined
        ? {}
        : { heartbeatTurnsAfterMinutes }),
      ...(heartbeatTurnText === undefined ? {} : { heartbeatTurnText }),
      ...(recentHeartbeatTurnTexts.length === 0
        ? {}
        : {
            recentHeartbeatTurnTexts: recentHeartbeatTurnTexts.slice(
              0,
              MAX_PROJECT_HEARTBEAT_RECENT_TEXTS,
            ),
          }),
      updatedAt,
    };
  }

  private normalizeProjectCodeNameMetadata(
    metadata: ProjectCodeNameMetadata,
  ): ProjectCodeNameMetadata | undefined {
    if (!metadata || typeof metadata !== "object") return undefined;
    try {
      const codeName = normalizeProjectCodeName(metadata.codeName);
      const projectName =
        typeof metadata.projectName === "string" && metadata.projectName.trim()
          ? metadata.projectName.trim()
          : "project";
      const updatedAt = Number.isFinite(new Date(metadata.updatedAt).getTime())
        ? metadata.updatedAt
        : new Date(0).toISOString();
      const source = metadata.source === "manual" ? "manual" : "generated";
      return { codeName, projectName, source, updatedAt };
    } catch {
      return undefined;
    }
  }

  private ensureProjectCodeNamesInMemory(
    projects: readonly { id: string; name: string }[],
  ): boolean {
    this.state.projectCodeNames ??= {};
    const records = this.state.projectCodeNames;
    const projectNameById = new Map(
      projects.map((project) => [
        this.canonicalProjectId(project.id),
        project.name,
      ]),
    );
    const allProjectNamesById = new Map(
      Object.entries(records).map(([projectId, metadata]) => [
        projectId,
        metadata.projectName,
      ]),
    );
    for (const [projectId, projectName] of projectNameById) {
      allProjectNamesById.set(projectId, projectName);
    }
    const reserved = new Set<string>();
    const needsAllocation: Array<{ projectId: string; projectName: string }> =
      [];
    const needsAllocationIds = new Set<string>();
    let changed = false;

    for (const projectId of Object.keys(records).sort()) {
      const metadata = records[projectId];
      if (!metadata) continue;
      const key = projectCodeNameKey(metadata.codeName);
      const currentProjectName = projectNameById.get(projectId);
      const prefixesAnotherProject = [...allProjectNamesById].some(
        ([candidateProjectId, projectName]) =>
          candidateProjectId !== projectId &&
          projectCodeNamePrefixesProjectName(metadata.codeName, projectName),
      );
      if (
        reserved.has(key) ||
        (metadata.source !== "manual" && prefixesAnotherProject)
      ) {
        delete records[projectId];
        needsAllocation.push({
          projectId,
          projectName: currentProjectName ?? metadata.projectName,
        });
        needsAllocationIds.add(projectId);
        changed = true;
        continue;
      }
      reserved.add(key);
      if (currentProjectName && currentProjectName !== metadata.projectName) {
        records[projectId] = { ...metadata, projectName: currentProjectName };
        changed = true;
      }
    }

    for (const project of projects) {
      const projectId = this.canonicalProjectId(project.id);
      if (!records[projectId] && !needsAllocationIds.has(projectId)) {
        needsAllocation.push({ projectId, projectName: project.name });
        needsAllocationIds.add(projectId);
      }
    }

    needsAllocation.sort(
      (left, right) =>
        left.projectName.localeCompare(right.projectName) ||
        left.projectId.localeCompare(right.projectId),
    );
    const updatedAt = new Date().toISOString();
    for (const project of needsAllocation) {
      const codeName = allocateProjectCodeName(
        project.projectName,
        reserved,
        [...allProjectNamesById]
          .filter(([projectId]) => projectId !== project.projectId)
          .map(([, projectName]) => projectName),
      );
      records[project.projectId] = {
        codeName,
        projectName: project.projectName,
        source: "generated",
        updatedAt,
      };
      reserved.add(projectCodeNameKey(codeName));
      changed = true;
    }
    return changed;
  }

  private withRecentHeartbeatText(
    current: string[] | undefined,
    text: string,
  ): string[] {
    return [text, ...(current ?? []).filter((value) => value !== text)].slice(
      0,
      MAX_PROJECT_HEARTBEAT_RECENT_TEXTS,
    );
  }

  private deleteProjectsByIdentity(projectPath: string): void {
    const targetIdentity = getProjectIdentityKey(projectPath);
    for (const [projectId, metadata] of Object.entries(this.state.projects)) {
      if (getProjectIdentityKey(metadata.path) === targetIdentity) {
        delete this.state.projects[projectId];
      }
    }
  }

  private deleteHiddenProjectsByIdentity(projectPath: string): void {
    if (!this.state.hiddenProjects) return;
    const targetIdentity = getProjectIdentityKey(projectPath);
    for (const [projectId, metadata] of Object.entries(
      this.state.hiddenProjects,
    )) {
      if (getProjectIdentityKey(metadata.path) === targetIdentity) {
        delete this.state.hiddenProjects[projectId];
      }
    }
  }
}
