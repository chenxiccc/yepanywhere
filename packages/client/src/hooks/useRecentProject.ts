import { useCallback, useEffect, useState } from "react";
import { BROWSER_LOCAL_KEYS } from "../lib/storageKeys";

interface ProjectLike {
  id: string;
}

/**
 * Get the most recently visited project ID from localStorage.
 * Returns null if none has been set.
 */
export function getRecentProjectId(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(BROWSER_LOCAL_KEYS.recentProject);
}

/**
 * Set the most recently visited project ID in localStorage.
 */
export function setRecentProjectId(projectId: string): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(BROWSER_LOCAL_KEYS.recentProject, projectId);
}

/**
 * Resolve the best available project ID for project-scoped pages and actions.
 *
 * Prefers the recent project stored in localStorage when it still exists in the
 * current project list, then an optional caller-provided fallback, then the
 * first available project.
 */
export function resolvePreferredProjectId<T extends ProjectLike>(
  projects: readonly T[],
  fallbackProjectId?: string | null,
): string | null {
  const recentProjectId = getRecentProjectId();
  if (
    recentProjectId &&
    projects.some((project) => project.id === recentProjectId)
  ) {
    return recentProjectId;
  }

  if (
    fallbackProjectId &&
    projects.some((project) => project.id === fallbackProjectId)
  ) {
    return fallbackProjectId;
  }

  return projects[0]?.id ?? null;
}

/**
 * Extract the route-scoped project ID from project-owned pages.
 *
 * Matches direct and relay-mode paths such as:
 * - /projects/:projectId
 * - /projects/:projectId/sessions/:sessionId
 * - /remote/-/relay/:server/projects/:projectId/sessions/:sessionId
 */
export function extractProjectIdFromPath(pathname: string): string | null {
  const match = pathname.match(/\/projects\/([^/]+)/);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

/**
 * Extract the visible project context from a route location.
 *
 * Different pages express project context differently: project-owned routes put
 * it in the path, New Session/Git Status use projectId, and the global
 * Sessions/Inbox filters use project.
 */
export function getProjectIdFromLocation(
  pathname: string,
  search: string,
): string | null {
  const searchParams = new URLSearchParams(search);
  return (
    searchParams.get("projectId") ||
    searchParams.get("project") ||
    extractProjectIdFromPath(pathname)
  );
}

/**
 * Hook that tracks the most recently visited project.
 * - Returns the current recent project ID
 * - Provides a setter to update it (call when navigating to a project)
 * - Uses localStorage (persists across tabs and browser sessions)
 */
export function useRecentProject(): [
  string | null,
  (projectId: string) => void,
] {
  const [recentProjectId, setRecentProjectIdState] = useState<string | null>(
    () => getRecentProjectId(),
  );

  const setRecentProject = useCallback((projectId: string) => {
    setRecentProjectId(projectId);
    setRecentProjectIdState(projectId);
  }, []);

  // Sync with sessionStorage on mount (in case another component updated it)
  useEffect(() => {
    setRecentProjectIdState(getRecentProjectId());
  }, []);

  return [recentProjectId, setRecentProject];
}
