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
  canonicalizeProjectPath,
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

export interface ProjectMetadataState {
  /** Map of projectId -> metadata */
  projects: Record<string, ProjectMetadata>;
  /** Map of projectId -> hidden project metadata */
  hiddenProjects?: Record<string, HiddenProjectMetadata>;
  /** Schema version for future migrations */
  version: number;
}

const CURRENT_VERSION = 2;

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

  /**
   * Add a project. The projectId should be a UrlProjectId (base64url encoded path).
   */
  async addProject(projectId: string, projectPath: string): Promise<void> {
    const canonicalPath = canonicalizeProjectPath(projectPath);
    const canonicalProjectId = encodeProjectId(canonicalPath);
    if (projectId !== canonicalProjectId) {
      delete this.state.projects[projectId];
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
    if (this.state.projects[projectId]) {
      const { [projectId]: _, ...rest } = this.state.projects;
      this.state.projects = rest;
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
      version: CURRENT_VERSION,
    };
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
