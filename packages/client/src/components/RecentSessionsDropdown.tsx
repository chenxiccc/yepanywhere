import { useEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { Link, useNavigate } from "react-router-dom";
import type { GlobalSessionItem } from "../api/client";
import type { AgentActivity } from "../hooks/useFileActivity";
import { useGlobalSessionsFeed } from "../hooks/useGlobalSessionsFeed";
import { setElementTextTooltip } from "../hooks/useTooltipAppearance";
import {
  buildBtwAsideParentHref,
  getBtwAsideSessionDisplayTitle,
  isBtwAsideSessionTitle,
} from "../lib/btwAsideSessions";
import { toBrowserAppHref } from "../lib/appHref";
import { sessionCollectionRecordsToGlobalSessionItems } from "../lib/sessionCollectionRecords";
import { useSessionCollectionQueryRecords } from "../lib/clientSummaryStore";
import { ProviderBadge } from "./ProviderBadge";
import { ThinkingIndicator } from "./ThinkingIndicator";
import styles from "./RecentSessionsDropdown.module.css";

const MAX_RECENT_SESSIONS = 10;
const DROPDOWN_MAX_WIDTH_PX = 830;
const DROPDOWN_MARGIN_PX = 8;

/**
 * Literal class names kept on `/btw` aside rows and badges purely so the two
 * global rules in `index.css` that SessionListItem shares still match. They
 * carry no styling of their own; everything else is module-owned.
 */
const BTW_ROW_INTEROP_CLASSES = "recent-session-item btw-aside-session";
const BTW_TITLE_INTEROP_CLASS = "recent-session-title";
const BTW_BADGE_INTEROP_CLASSES = "recent-sessions-badge btw";

function classNames(...values: (string | false | null | undefined)[]): string {
  return values.filter(Boolean).join(" ");
}

interface RecentSessionsDropdownProps {
  /** Current session ID (will be excluded from list) */
  currentSessionId: string;
  /** Whether the dropdown is open */
  isOpen: boolean;
  /** Called when dropdown should close */
  onClose: () => void;
  /** Called when navigating to a session */
  onNavigate: (sessionId: string, projectId: string) => void;
  /** Trigger element ref for positioning */
  triggerRef: React.RefObject<HTMLElement | null>;
  /** Base path prefix for relay mode (e.g., "/remote/my-server") */
  basePath?: string;
}

/** Format time as "Xm ago" style */
function formatRelativeTime(timestamp: string): string {
  const now = Date.now();
  const then = new Date(timestamp).getTime();
  const diffMs = now - then;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "now";
  if (diffMins < 60) return `${diffMins}m`;
  if (diffHours < 24) return `${diffHours}h`;
  if (diffDays < 7) return `${diffDays}d`;
  return new Date(timestamp).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

/** Get display title */
function getDisplayTitle(session: GlobalSessionItem): string {
  return (
    session.customTitle || session.fullTitle || session.title || "Untitled"
  );
}

function getVisibleDisplayTitle(title: string): string {
  return isBtwAsideSessionTitle(title)
    ? getBtwAsideSessionDisplayTitle(title)
    : title;
}

function getTitleTooltip(session: GlobalSessionItem, title: string): string {
  return session.customTitle ? title : (session.fullTitle ?? title);
}

/** Compact status indicator */
function StatusIndicator({ session }: { session: GlobalSessionItem }) {
  const activity = session.activity as AgentActivity | undefined;

  if (activity === "in-turn") {
    return <ThinkingIndicator />;
  }

  if (session.pendingInputType) {
    const label = session.pendingInputType === "tool-approval" ? "Appr" : "Q";
    return (
      <span className={`${styles.badge} ${styles.needsInput}`}>{label}</span>
    );
  }

  if (session.ownership.owner === "external") {
    return <span className={`${styles.badge} ${styles.external}`}>Ext</span>;
  }

  return null;
}

export function RecentSessionsDropdown({
  currentSessionId,
  isOpen,
  onClose,
  onNavigate,
  triggerRef,
  basePath = "",
}: RecentSessionsDropdownProps) {
  const dropdownRef = useRef<HTMLDivElement>(null);
  const lastTouchPointerAtRef = useRef(0);
  const navigate = useNavigate();

  // Feed recent sessions across all projects; rows render from the collection.
  const feed = useGlobalSessionsFeed({
    limit: MAX_RECENT_SESSIONS + 5,
    includeStats: false,
  });
  const sessionRecords = useSessionCollectionQueryRecords(feed.query);
  const sessions = useMemo(
    () => sessionCollectionRecordsToGlobalSessionItems(sessionRecords),
    [sessionRecords],
  );

  // Filter out current session and limit
  const recentSessions = sessions
    .filter((s) => s.id !== currentSessionId && !s.isArchived)
    .slice(0, MAX_RECENT_SESSIONS);

  // Close on click outside
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(target) &&
        triggerRef.current &&
        !triggerRef.current.contains(target)
      ) {
        onClose();
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, onClose, triggerRef]);

  // Close on scroll
  useEffect(() => {
    if (!isOpen) return;

    const handleScroll = () => onClose();
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  // Position dropdown below the title row and keep the right edge on-screen.
  const triggerRect = triggerRef.current?.getBoundingClientRect();
  const style: React.CSSProperties = (() => {
    if (!triggerRect || typeof window === "undefined") return {};

    const dropdownWidth = Math.min(
      DROPDOWN_MAX_WIDTH_PX,
      Math.max(0, window.innerWidth - DROPDOWN_MARGIN_PX * 2),
    );
    const maxLeft = Math.max(
      DROPDOWN_MARGIN_PX,
      window.innerWidth - dropdownWidth - DROPDOWN_MARGIN_PX,
    );
    const left = Math.min(
      Math.max(DROPDOWN_MARGIN_PX, triggerRect.left),
      maxLeft,
    );

    return {
      position: "fixed",
      top: triggerRect.bottom + 4,
      left,
      width: dropdownWidth,
    };
  })();

  const dropdown = (
    <div ref={dropdownRef} className={styles.dropdown} style={style}>
      <div className={styles.header}>Recent Sessions</div>
      {recentSessions.length === 0 ? (
        <div className={styles.empty}>No other sessions</div>
      ) : (
        <div className={styles.list}>
          {recentSessions.map((session) => {
            const title = getDisplayTitle(session);
            const titleTooltip = getTitleTooltip(session, title);
            const isBtwAside =
              !!session.parentSessionId || isBtwAsideSessionTitle(title);
            const parentSessionId = session.parentSessionId;
            const parentHref =
              parentSessionId && isBtwAside
                ? buildBtwAsideParentHref(
                    basePath,
                    session.projectId,
                    parentSessionId,
                    session.id,
                  )
                : null;
            return (
              <Link
                key={session.id}
                to={`${basePath}/projects/${session.projectId}/sessions/${session.id}`}
                className={classNames(
                  styles.item,
                  session.hasUnread && styles.unread,
                  isBtwAside && BTW_ROW_INTEROP_CLASSES,
                )}
                onClick={() => {
                  onNavigate(session.id, session.projectId);
                  onClose();
                }}
                onPointerEnter={(event) => {
                  setElementTextTooltip(
                    event.currentTarget,
                    event.pointerType === "touch" ? null : titleTooltip,
                  );
                }}
                onPointerDown={(event) => {
                  if (event.pointerType === "touch") {
                    lastTouchPointerAtRef.current = Date.now();
                    setElementTextTooltip(event.currentTarget, null);
                  }
                }}
                onFocus={(event) => {
                  if (Date.now() - lastTouchPointerAtRef.current > 1000) {
                    setElementTextTooltip(event.currentTarget, titleTooltip);
                  }
                }}
                onBlur={(event) => {
                  setElementTextTooltip(event.currentTarget, null);
                }}
              >
                <div className={styles.content}>
                  <span
                    className={classNames(
                      styles.title,
                      isBtwAside && BTW_TITLE_INTEROP_CLASS,
                    )}
                  >
                    {session.isStarred && (
                      <svg
                        className={styles.star}
                        width="10"
                        height="10"
                        viewBox="0 0 24 24"
                        fill="currentColor"
                        stroke="currentColor"
                        strokeWidth="2"
                        aria-hidden="true"
                      >
                        <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                      </svg>
                    )}
                    {isBtwAside && (
                      // biome-ignore lint/a11y/noStaticElementInteractions: clickable variant has link role and keyboard handling; inert variant only shows the badge
                      <span
                        className={`${styles.badge} ${BTW_BADGE_INTEROP_CLASSES}`}
                        title={
                          parentHref
                            ? "Open parent session with this /btw aside visible"
                            : "/btw aside session"
                        }
                        role={parentHref ? "link" : undefined}
                        tabIndex={parentHref ? 0 : undefined}
                        onClick={(e) => {
                          if (!parentHref || !parentSessionId) return;
                          e.preventDefault();
                          e.stopPropagation();
                          if (e.metaKey || e.ctrlKey || e.shiftKey) {
                            window.open(
                              toBrowserAppHref(parentHref),
                              "_blank",
                              "noopener",
                            );
                            return;
                          }
                          navigate(parentHref);
                          onNavigate(parentSessionId, session.projectId);
                          onClose();
                        }}
                        onKeyDown={(e) => {
                          if (
                            !parentHref ||
                            !parentSessionId ||
                            (e.key !== "Enter" && e.key !== " ")
                          ) {
                            return;
                          }
                          e.preventDefault();
                          e.stopPropagation();
                          navigate(parentHref);
                          onNavigate(parentSessionId, session.projectId);
                          onClose();
                        }}
                      >
                        /btw
                      </span>
                    )}
                    <span className={styles.titleText}>
                      {getVisibleDisplayTitle(title)}
                    </span>
                  </span>
                  <span className={styles.details}>
                    <ProviderBadge
                      provider={session.provider}
                      model={session.model}
                      className={styles.providerBadge}
                    />
                    <span className={styles.project}>
                      {session.projectName}
                    </span>
                    <span className={styles.time}>
                      {formatRelativeTime(session.updatedAt)}
                    </span>
                    <StatusIndicator session={session} />
                  </span>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );

  // Use portal to escape any overflow clipping
  return createPortal(dropdown, document.body);
}
