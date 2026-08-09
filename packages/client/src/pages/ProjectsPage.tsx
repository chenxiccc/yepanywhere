import {
  PROJECT_SESSION_DEFAULTS_CAPABILITY,
  type ProjectQueueMessage,
  serverHasCapability,
} from "@yep-anywhere/shared";
import { useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../api/client";
import { PageHeader } from "../components/PageHeader";
import { ProjectCard } from "../components/ProjectCard";
import { ProjectQueueSection } from "../components/ProjectQueueSection";
import { ProjectSessionDefaultsModal } from "../components/ProjectSessionDefaultsModal";
import { useProjectQueues } from "../hooks/useProjectQueues";
import { useProjects } from "../hooks/useProjects";
import { useRemoteBasePath } from "../hooks/useRemoteBasePath";
import { useVersion } from "../hooks/useVersion";
import { useI18n } from "../i18n";
import { MainContent, useNavigationLayout } from "../layouts";
import { useInboxCountsByProject } from "../lib/clientSummaryStore";
import { serverSupportsProjectQueue } from "../lib/projectQueueVisibility";
import type { Project } from "../types";

const EMPTY_PROJECT_QUEUE_PROJECT_IDS: readonly string[] = [];

export function ProjectsPage() {
  const { t } = useI18n();
  const { projects, loading, error, refetch } = useProjects();
  const { version } = useVersion();
  const supportsProjectQueue = serverSupportsProjectQueue(version);
  const supportsProjectSessionDefaults = serverHasCapability(
    version,
    PROJECT_SESSION_DEFAULTS_CAPABILITY,
  );
  const inboxCountsByProject = useInboxCountsByProject();
  const [showAddForm, setShowAddForm] = useState(false);
  const [newProjectPath, setNewProjectPath] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [settingsProject, setSettingsProject] = useState<Project | null>(null);
  const [deletingProjectId, setDeletingProjectId] = useState<string | null>(
    null,
  );
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const basePath = useRemoteBasePath();
  const highlightedQueueItemId = searchParams.get("queueItem");

  const { openSidebar, isWideScreen, toggleSidebar, isSidebarCollapsed } =
    useNavigationLayout();

  const projectIds = useMemo(
    () => projects.map((project) => project.id),
    [projects],
  );
  const projectQueueProjectIds = supportsProjectQueue
    ? projectIds
    : EMPTY_PROJECT_QUEUE_PROJECT_IDS;
  const projectQueues = useProjectQueues(projectQueueProjectIds);
  const queueStateByProject = useMemo(() => {
    if (!supportsProjectQueue) {
      return new Map<string, { count: number; hasFailed: boolean }>();
    }
    const queueState = new Map<string, { count: number; hasFailed: boolean }>();
    for (const [projectId, items] of Object.entries(
      projectQueues.queuesByProject,
    )) {
      const visibleCount = items.filter(
        (item) => item.status === "queued" || item.status === "failed",
      ).length;
      if (visibleCount > 0) {
        queueState.set(projectId, {
          count: visibleCount,
          hasFailed: items.some((item) => item.status === "failed"),
        });
      }
    }
    return queueState;
  }, [projectQueues.queuesByProject, supportsProjectQueue]);

  // Sort projects: those needing attention first, then by recency
  const sortedProjects = useMemo(() => {
    return [...projects].sort((a, b) => {
      const aNeeds = inboxCountsByProject.get(a.id)?.needsAttention ?? 0;
      const bNeeds = inboxCountsByProject.get(b.id)?.needsAttention ?? 0;

      // Projects needing attention come first
      if (aNeeds > 0 && bNeeds === 0) return -1;
      if (bNeeds > 0 && aNeeds === 0) return 1;

      // Then sort by last activity (most recent first)
      const aTime = a.lastActivity ? new Date(a.lastActivity).getTime() : 0;
      const bTime = b.lastActivity ? new Date(b.lastActivity).getTime() : 0;
      return bTime - aTime;
    });
  }, [projects, inboxCountsByProject]);

  const handleAddProject = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newProjectPath.trim()) return;

    setAdding(true);
    setAddError(null);

    try {
      const { project } = await api.addProject(newProjectPath.trim());
      await refetch();
      setNewProjectPath("");
      setShowAddForm(false);
      // Navigate to sessions filtered by the new project
      navigate(`${basePath}/sessions?project=${project.id}`);
    } catch (err) {
      setAddError(err instanceof Error ? err.message : t("projectsAddFailed"));
    } finally {
      setAdding(false);
    }
  };

  const handleDeleteProject = async (project: Project) => {
    if (!confirm(t("projectsDeleteConfirm", { name: project.name }))) {
      return;
    }

    setDeletingProjectId(project.id);
    setDeleteError(null);

    try {
      await api.deleteProject(project.id);
      await refetch();
    } catch (err) {
      setDeleteError(
        err instanceof Error ? err.message : t("projectsDeleteFailed"),
      );
    } finally {
      setDeletingProjectId(null);
    }
  };

  const handleDeleteQueueItem = async (projectId: string, itemId: string) => {
    try {
      await projectQueues.deleteItem(projectId, itemId);
    } catch {
      // The hook exposes the error in the queue section.
    }
  };

  const handleResumeRecoveredQueueItem = async (
    sessionId: string,
    queueId: string,
  ) => {
    try {
      await projectQueues.resumeRecoveredItem(sessionId, queueId);
    } catch {
      // The hook exposes the error in the queue section.
    }
  };

  const handleDeleteRecoveredQueueItem = async (
    sessionId: string,
    queueId: string,
  ) => {
    try {
      await projectQueues.deleteRecoveredItem(sessionId, queueId);
    } catch {
      // The hook exposes the error in the queue section.
    }
  };

  const handlePauseProjectQueue = async () => {
    try {
      await projectQueues.pauseDispatch();
    } catch {
      // The hook exposes the error in the queue section.
    }
  };

  const handleResumeProjectQueue = async () => {
    try {
      await projectQueues.resumeDispatch();
    } catch {
      // The hook exposes the error in the queue section.
    }
  };

  const handlePromoteProjectQueueItem = async (
    projectId: string,
    itemId: string,
    options?: { force?: boolean },
  ) => {
    try {
      await projectQueues.promoteNow(projectId, itemId, options);
    } catch {
      // The hook exposes the error in the queue section.
    }
  };

  const handleRetryQueueItem = async (projectId: string, itemId: string) => {
    try {
      await projectQueues.retryItem(projectId, itemId);
    } catch {
      // The hook exposes the error in the queue section.
    }
  };

  const handleMoveQueueItemToTop = async (
    projectId: string,
    itemId: string,
  ) => {
    try {
      await projectQueues.moveItemToTop(projectId, itemId);
    } catch {
      // The hook exposes the error in the queue section.
    }
  };

  const handleUpdateQueueItem = async (
    projectId: string,
    itemId: string,
    message: ProjectQueueMessage,
  ) => {
    try {
      await projectQueues.updateItem(projectId, itemId, { message });
    } catch {
      // The hook exposes the error in the queue section.
    }
  };

  if (loading) return <div className="loading">{t("projectsLoading")}</div>;
  if (error) {
    return (
      <div className="error">
        {t("projectsErrorPrefix")} {error.message}
      </div>
    );
  }

  const isEmpty = projects.length === 0;

  return (
    <MainContent isWideScreen={isWideScreen}>
      <PageHeader
        title={t("pageTitleProjects")}
        onOpenSidebar={openSidebar}
        onToggleSidebar={toggleSidebar}
        isWideScreen={isWideScreen}
        isSidebarCollapsed={isSidebarCollapsed}
      />

      <main className="page-scroll-container">
        <div className="page-content-inner">
          {/* Toolbar with Add Project button */}
          <div className="inbox-toolbar">
            {!showAddForm ? (
              <button
                type="button"
                className="inbox-refresh-button"
                onClick={() => setShowAddForm(true)}
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
                {t("projectsAdd")}
              </button>
            ) : (
              <form onSubmit={handleAddProject} className="add-project-form">
                <input
                  type="text"
                  value={newProjectPath}
                  onChange={(e) => setNewProjectPath(e.target.value)}
                  placeholder={t("projectsAddPlaceholder")}
                  disabled={adding}
                />
                <div className="add-project-actions">
                  <button
                    type="submit"
                    disabled={adding || !newProjectPath.trim()}
                  >
                    {adding ? t("projectsAdding") : t("projectsAddConfirm")}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setShowAddForm(false);
                      setNewProjectPath("");
                      setAddError(null);
                    }}
                    disabled={adding}
                  >
                    {t("projectsCancel")}
                  </button>
                </div>
                {addError && (
                  <div className="add-project-error">{addError}</div>
                )}
              </form>
            )}
          </div>
          {deleteError && (
            <div className="add-project-error">{deleteError}</div>
          )}

          {supportsProjectQueue && (
            <ProjectQueueSection
              projects={projects}
              items={projectQueues.items}
              recoveredSessionQueues={projectQueues.recoveredSessionQueues}
              loading={projectQueues.loading}
              error={projectQueues.error}
              mutatingItemId={projectQueues.mutatingItemId}
              mutatingRecoveredQueueId={projectQueues.mutatingRecoveredQueueId}
              mutatingDispatchState={projectQueues.mutatingDispatchState}
              mutatingPromoteItemId={projectQueues.mutatingPromoteItemId}
              dispatchState={projectQueues.dispatchState}
              projectStatusesByProject={projectQueues.projectStatusesByProject}
              highlightedItemId={highlightedQueueItemId}
              basePath={basePath}
              onPauseDispatch={handlePauseProjectQueue}
              onResumeDispatch={handleResumeProjectQueue}
              onPromoteNow={handlePromoteProjectQueueItem}
              onDeleteItem={handleDeleteQueueItem}
              onResumeRecoveredItem={handleResumeRecoveredQueueItem}
              onDeleteRecoveredItem={handleDeleteRecoveredQueueItem}
              onRetryItem={handleRetryQueueItem}
              onMoveItemToTop={handleMoveQueueItemToTop}
              onUpdateItem={handleUpdateQueueItem}
            />
          )}

          {isEmpty ? (
            <div className="inbox-empty">
              <svg
                width="48"
                height="48"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              </svg>
              <h3>{t("projectsEmptyTitle")}</h3>
              <p>{t("projectsEmptyDescription")}</p>
            </div>
          ) : (
            <ul className="project-list-cards">
              {sortedProjects.map((project) => (
                <ProjectCard
                  key={project.id}
                  project={project}
                  needsAttentionCount={
                    inboxCountsByProject.get(project.id)?.needsAttention ?? 0
                  }
                  thinkingCount={
                    inboxCountsByProject.get(project.id)?.active ?? 0
                  }
                  queueCount={queueStateByProject.get(project.id)?.count ?? 0}
                  hasQueueWarning={
                    queueStateByProject.get(project.id)?.hasFailed ?? false
                  }
                  basePath={basePath}
                  onDeleteProject={handleDeleteProject}
                  onOpenSettings={
                    supportsProjectSessionDefaults
                      ? setSettingsProject
                      : undefined
                  }
                  isDeleting={deletingProjectId === project.id}
                />
              ))}
            </ul>
          )}
        </div>
      </main>
      {settingsProject && (
        <ProjectSessionDefaultsModal
          projectId={settingsProject.id}
          projectName={settingsProject.name}
          onClose={() => setSettingsProject(null)}
        />
      )}
    </MainContent>
  );
}
