import {
  MAX_PROJECT_CODE_NAME_LENGTH,
  normalizeProjectCodeName,
} from "@yep-anywhere/shared";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useI18n } from "../i18n";
import { shortenPath } from "../lib/text";
import type { Project } from "../types";
import styles from "./ProjectCard.module.css";
import { ThinkingIndicator } from "./ThinkingIndicator";

interface ProjectCardProps {
  project: Project;
  /** Number of sessions needing approval/input in this project */
  needsAttentionCount: number;
  /** Number of sessions actively thinking (running, no pending input) */
  thinkingCount: number;
  /** Number of queued/failed Project Queue items in this project */
  queueCount?: number;
  /** Whether a Project Queue item is paused for explicit retry */
  hasQueueWarning?: boolean;
  /** Base path prefix for relay mode (e.g., "/remote/my-server") */
  basePath?: string;
  /** Called when the user asks to remove the project from YA lists */
  onDeleteProject?: (project: Project) => void;
  /** Called when the user opens this project's defaults */
  onOpenSettings?: (project: Project) => void;
  /** Persists an inline edit to this project's short code name. */
  onUpdateCodeName?: (project: Project, codeName: string) => Promise<void>;
  /** Whether this project is currently being removed */
  isDeleting?: boolean;
}

/**
 * Format relative time for display
 */
function formatRelativeTime(timestamp: string): string {
  const now = Date.now();
  const then = new Date(timestamp).getTime();
  const diffMs = now - then;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

/**
 * Card component for displaying a project in the projects list.
 * Matches visual style of SessionListItem card mode.
 */
export function ProjectCard({
  project,
  needsAttentionCount,
  thinkingCount,
  queueCount = 0,
  hasQueueWarning = false,
  basePath = "",
  onDeleteProject,
  onOpenSettings,
  onUpdateCodeName,
  isDeleting = false,
}: ProjectCardProps) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const [editingCodeName, setEditingCodeName] = useState(false);
  const [draftCodeName, setDraftCodeName] = useState(project.codeName ?? "");
  const [codeNameError, setCodeNameError] = useState<string | null>(null);
  const [savingCodeName, setSavingCodeName] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const codeNameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const closeIfOutside = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", closeIfOutside);
    return () => document.removeEventListener("mousedown", closeIfOutside);
  }, [menuOpen]);

  useEffect(() => {
    if (!editingCodeName) return;
    codeNameInputRef.current?.focus();
    codeNameInputRef.current?.select();
  }, [editingCodeName]);

  const handleNewSession = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    navigate(`${basePath}/new-session?projectId=${project.id}`);
  };

  const handleDeleteProject = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setMenuOpen(false);
    onDeleteProject?.(project);
  };

  const handleOpenSettings = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setMenuOpen(false);
    onOpenSettings?.(project);
  };

  const startCodeNameEdit = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDraftCodeName(project.codeName ?? "");
    setCodeNameError(null);
    setEditingCodeName(true);
  };

  const cancelCodeNameEdit = (e: React.SyntheticEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDraftCodeName(project.codeName ?? "");
    setCodeNameError(null);
    setEditingCodeName(false);
  };

  const commitCodeNameEdit = async () => {
    if (!onUpdateCodeName || savingCodeName) return;
    let codeName: string;
    try {
      codeName = normalizeProjectCodeName(draftCodeName);
    } catch (error) {
      setCodeNameError(
        error instanceof Error ? error.message : t("projectCodeNameInvalid"),
      );
      requestAnimationFrame(() => codeNameInputRef.current?.focus());
      return;
    }
    if (codeName === project.codeName) {
      setEditingCodeName(false);
      return;
    }

    setSavingCodeName(true);
    setCodeNameError(null);
    try {
      await onUpdateCodeName(project, codeName);
      setEditingCodeName(false);
    } catch (error) {
      setCodeNameError(
        error instanceof Error ? error.message : t("projectCodeNameSaveFailed"),
      );
      requestAnimationFrame(() => codeNameInputRef.current?.focus());
    } finally {
      setSavingCodeName(false);
    }
  };

  return (
    <li className={styles.card}>
      <Link
        to={`${basePath}/sessions?project=${project.id}&source=projects`}
        className={styles.link}
        data-project-card-link=""
        onContextMenu={(event) => {
          if (!onOpenSettings && !onDeleteProject) return;
          event.preventDefault();
          setMenuOpen(true);
        }}
      >
        <div className={styles.header}>
          {(onOpenSettings || onDeleteProject) && (
            <div className={styles.menu} ref={menuRef}>
              <button
                type="button"
                className={styles.menuTrigger}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setMenuOpen((open) => !open);
                }}
                title={t("projectCardSettings")}
                aria-label={t("projectCardSettings")}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <circle cx="5" cy="12" r="1.75" />
                  <circle cx="12" cy="12" r="1.75" />
                  <circle cx="19" cy="12" r="1.75" />
                </svg>
              </button>
              {menuOpen && (
                <div className={styles.menuDropdown} role="menu">
                  {onOpenSettings && (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={handleOpenSettings}
                    >
                      {t("projectCardSettings")}
                    </button>
                  )}
                  {onDeleteProject && (
                    <button
                      type="button"
                      role="menuitem"
                      className={styles.deleteMenuItem}
                      onClick={handleDeleteProject}
                      disabled={isDeleting}
                    >
                      {t("projectsDelete")}
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
          <div className={styles.identity}>
            <strong className={styles.name}>
              {needsAttentionCount > 0 && (
                <span className={styles.attentionBadge}>
                  {needsAttentionCount}
                </span>
              )}
              {queueCount > 0 && (
                <span
                  className={styles.queueBadge}
                  title={t("projectCardQueueCount", { count: queueCount })}
                >
                  {queueCount}
                </span>
              )}
              {hasQueueWarning && (
                <span
                  className={styles.queueWarningBadge}
                  role="img"
                  title={t("projectCardQueueWarning")}
                  aria-label={t("projectCardQueueWarning")}
                >
                  !
                </span>
              )}
              {project.name}
            </strong>
            {project.codeName && (
              <div className={styles.codeNameSlot}>
                {editingCodeName && onUpdateCodeName ? (
                  <div className={styles.codeNameEditor}>
                    <input
                      ref={codeNameInputRef}
                      aria-label={t("projectCodeNameLabel")}
                      aria-invalid={codeNameError ? true : undefined}
                      className={styles.codeNameInput}
                      disabled={savingCodeName}
                      maxLength={MAX_PROJECT_CODE_NAME_LENGTH}
                      value={draftCodeName}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                      }}
                      onChange={(event) => {
                        setDraftCodeName(event.target.value);
                        setCodeNameError(null);
                      }}
                      onBlur={() => void commitCodeNameEdit()}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          event.currentTarget.blur();
                        } else if (event.key === "Escape") {
                          cancelCodeNameEdit(event);
                        }
                      }}
                    />
                    <button
                      type="button"
                      className={styles.cancelCodeName}
                      aria-label={t("projectCodeNameCancelEdit")}
                      disabled={savingCodeName}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={cancelCodeNameEdit}
                    >
                      ×
                    </button>
                  </div>
                ) : onUpdateCodeName ? (
                  <button
                    type="button"
                    className={styles.codeName}
                    aria-label={t("projectCodeNameEdit")}
                    onClick={startCodeNameEdit}
                  >
                    {project.codeName}
                  </button>
                ) : (
                  <span className={styles.codeName}>{project.codeName}</span>
                )}
                {codeNameError && (
                  <span className={styles.codeNameError} role="alert">
                    {codeNameError}
                  </span>
                )}
              </div>
            )}
          </div>
          <button
            type="button"
            className={styles.newSession}
            onClick={handleNewSession}
            title={t("projectCardNewSession")}
            aria-label={t("projectCardNewSession")}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
        </div>
        <div className={styles.meta}>
          <span className={styles.path} title={project.path}>
            {shortenPath(project.path)}
          </span>
          <span className={styles.stats}>
            <span className={styles.sessions}>
              {project.sessionCount} session
              {project.sessionCount !== 1 ? "s" : ""}
            </span>
            {thinkingCount > 0 && (
              <span className={styles.thinking}>
                <ThinkingIndicator />
                <span>{thinkingCount}</span>
              </span>
            )}
            {project.lastActivity && (
              <>
                <span className={styles.separator}>·</span>
                <span className={styles.time}>
                  {formatRelativeTime(project.lastActivity)}
                </span>
              </>
            )}
          </span>
        </div>
      </Link>
    </li>
  );
}
