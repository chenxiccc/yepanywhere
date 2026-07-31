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
  /** Base path prefix for relay mode (e.g., "/remote/my-server") */
  basePath?: string;
  /** Called when the user asks to remove the project from YA lists */
  onDeleteProject?: (project: Project) => void;
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
  basePath = "",
  onDeleteProject,
  isDeleting = false,
}: ProjectCardProps) {
  const { t } = useI18n();
  const navigate = useNavigate();

  const handleNewSession = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    navigate(`${basePath}/new-session?projectId=${project.id}`);
  };

  const handleDeleteProject = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onDeleteProject?.(project);
  };

  return (
    <li className={styles.card}>
      <Link
        to={`${basePath}/sessions?project=${project.id}&source=projects`}
        className={styles.link}
        data-project-card-link=""
      >
        <div className={styles.header}>
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
            {project.name}
          </strong>
          <div className={styles.actions}>
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
            {onDeleteProject && (
              <button
                type="button"
                className={styles.delete}
                onClick={handleDeleteProject}
                disabled={isDeleting}
                title={t("projectsDelete")}
                aria-label={t("projectsDelete")}
              >
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M3 6h18" />
                  <path d="M8 6V4h8v2" />
                  <path d="M19 6l-1 14H6L5 6" />
                  <path d="M10 11v5" />
                  <path d="M14 11v5" />
                </svg>
              </button>
            )}
          </div>
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
