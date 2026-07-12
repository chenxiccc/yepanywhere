import { useCallback, useMemo } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { GIT_STATUS_ENHANCED_CAPABILITY } from "@yep-anywhere/shared";
import { useOptionalRemoteConnection } from "../contexts/RemoteConnectionContext";
import { useProjects } from "../hooks/useProjects";
import {
  getProjectIdFromLocation,
  resolvePreferredProjectId,
} from "../hooks/useRecentProject";
import { useRemoteBasePath } from "../hooks/useRemoteBasePath";
import { useVersion } from "../hooks/useVersion";
import { useI18n } from "../i18n";
import { serverSupportsProjectQueue } from "../lib/projectQueueVisibility";
import {
  useInboxCounts,
  useProjectQueueSidebarCount,
} from "../lib/clientSummaryStore";
import { AgentsNavItem } from "./AgentsNavItem";
import { SidebarIcons, SidebarNavItem, SidebarNavButton } from "./SidebarNavItem";

interface MobileTopNavProps {
  /** 打开移动端侧边栏抽屉 / Open the mobile sidebar drawer */
  openSidebar: () => void;
}

// 空项目队列占位，与 Sidebar.tsx 同款常量（类型对齐 ProjectQueueCountSource）。
// Empty project-queue placeholder mirroring Sidebar.tsx (typed to ProjectQueueCountSource).
const EMPTY_PROJECT_QUEUE_PROJECTS: readonly {
  id: string;
  projectQueueCount?: number;
  snapshotObservedAt?: number;
}[] = [];

/**
 * 手机端页头横向图标条 / Mobile header horizontal icon bar.
 *
 * 把侧边栏入口（收件箱/全部对话/项目/源码控制/文件-Git/设备/Agents/设置/切换主机）
 * 以纯图标横向排布，常驻页头第一行吸顶；汉堡按钮也并到这一行。
 * 仅移动端显示（≤1099px）。复用 SidebarNavItem/AgentsNavItem/SidebarNavButton，
 * 复用 active 判定、badge、ThinkingIndicator 全套逻辑，靠 CSS 隐藏文字、改横向样式。
 *
 * Places sidebar entries as icon-only horizontal items pinned at the top of the
 * mobile header (first sticky row); the hamburger toggle sits on the same row.
 * Mobile-only (≤1099px). Reuses SidebarNavItem/AgentsNavItem/SidebarNavButton so
 * active state, badges, and the ThinkingIndicator come for free; CSS hides the
 * labels and lays items out horizontally.
 */
export function MobileTopNav({ openSidebar }: MobileTopNavProps) {
  const { t } = useI18n();
  const basePath = useRemoteBasePath();
  const location = useLocation();
  const navigate = useNavigate();
  const remoteConnection = useOptionalRemoteConnection();

  const { version: versionInfo } = useVersion();
  const capabilities = versionInfo?.capabilities ?? [];
  const supportsProjectQueue = serverSupportsProjectQueue(versionInfo);

  const { needsAttention: inboxCount } = useInboxCounts();
  const { projects } = useProjects();

  const sourceControlProjectId = useMemo(
    () =>
      getProjectIdFromLocation(location.pathname, location.search) ??
      resolvePreferredProjectId(projects),
    [location.pathname, location.search, projects],
  );
  const sourceControlPath = sourceControlProjectId
    ? `/git-status?projectId=${encodeURIComponent(sourceControlProjectId)}`
    : "/git-status";
  const sourceManagerPath = sourceControlProjectId
    ? `/source-manager?projectId=${encodeURIComponent(sourceControlProjectId)}`
    : "/source-manager";

  const projectQueueSidebarCount = useProjectQueueSidebarCount(
    supportsProjectQueue ? projects : EMPTY_PROJECT_QUEUE_PROJECTS,
  );

  // 切换主机：断开当前 relay 连接并回到登录页（同 Sidebar.tsx 的 handleSwitchHost）。
  // Switch host: disconnect the current relay connection and return to login.
  const handleSwitchHost = useCallback(() => {
    remoteConnection?.disconnect();
    navigate("/login");
  }, [remoteConnection, navigate]);

  return (
    <nav className="mobile-top-nav">
      <button
        type="button"
        className="mobile-top-nav-item mobile-top-nav-item--toggle"
        onClick={openSidebar}
        title={t("actionOpenSidebar")}
        aria-label={t("actionOpenSidebar")}
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
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <line x1="9" y1="3" x2="9" y2="21" />
        </svg>
      </button>
      <SidebarNavItem
        to="/inbox"
        icon={SidebarIcons.inbox}
        label={t("sidebarInbox")}
        badge={inboxCount}
        basePath={basePath}
      />
      <SidebarNavItem
        to="/sessions"
        icon={SidebarIcons.allSessions}
        label={t("sidebarAllSessions")}
        basePath={basePath}
      />
      <SidebarNavItem
        to="/projects"
        icon={SidebarIcons.projects}
        label={t("sidebarProjects")}
        badge={supportsProjectQueue ? projectQueueSidebarCount : 0}
        badgeVariant="projectQueue"
        badgeTitle={t("projectCardQueueCount", {
          count: projectQueueSidebarCount,
        })}
        basePath={basePath}
      />
      {capabilities.includes(GIT_STATUS_ENHANCED_CAPABILITY) && (
        <SidebarNavItem
          to={sourceControlPath}
          icon={SidebarIcons.sourceControl}
          label={t("sidebarSourceControl")}
          basePath={basePath}
        />
      )}
      <SidebarNavItem
        to={sourceManagerPath}
        icon={SidebarIcons.fileGit}
        label={t("sidebarFileGit")}
        basePath={basePath}
      />
      {(capabilities.includes("deviceBridge") ||
        capabilities.includes("deviceBridge-download")) && (
        <SidebarNavItem
          to="/devices"
          icon={SidebarIcons.emulator}
          label={t("sidebarDevices")}
          basePath={basePath}
        />
      )}
      <AgentsNavItem basePath={basePath} />
      <SidebarNavItem
        to="/settings"
        icon={SidebarIcons.settings}
        label={t("sidebarSettings")}
        basePath={basePath}
      />
      {remoteConnection && (
        <SidebarNavButton
          className="sidebar-switch-host"
          onClick={handleSwitchHost}
          label={t("sidebarSwitchHost")}
          icon={
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
              <polyline points="17 1 21 5 17 9" />
              <path d="M3 11V9a4 4 0 0 1 4-4h14" />
              <polyline points="7 23 3 19 7 15" />
              <path d="M21 13v2a4 4 0 0 1-4 4H3" />
            </svg>
          }
        />
      )}
    </nav>
  );
}
