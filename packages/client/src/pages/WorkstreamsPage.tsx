import type {
  ProjectWorkstreamsResponse,
  Workstream,
  WorkstreamCheckoutPreviewResponse,
  WorkstreamKind,
  WorkstreamStatus,
} from "@yep-anywhere/shared";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useParams } from "react-router-dom";
import { api } from "../api/client";
import { PageHeader } from "../components/PageHeader";
import { useServerSettings } from "../hooks/useServerSettings";
import { useI18n } from "../i18n";
import { MainContent, useNavigationLayout } from "../layouts";
import { activityBus } from "../lib/activityBus";
import styles from "./WorkstreamsPage.module.css";

type WorkstreamsLoadState =
  | { status: "idle" | "loading" }
  | { status: "loaded"; data: ProjectWorkstreamsResponse }
  | { status: "error"; error: Error; statusCode?: number };

type WorkstreamsPreviewState =
  | { status: "idle" | "loading" }
  | { status: "loaded"; data: WorkstreamCheckoutPreviewResponse }
  | { status: "error"; error: Error; statusCode?: number };

function errorStatus(error: unknown): number | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof (error as { status?: unknown }).status === "number"
  ) {
    return (error as { status: number }).status;
  }
  return undefined;
}

function errorMessage(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback);
}

function WorkstreamsStateMessage({
  title,
  message,
  variant = "neutral",
}: {
  title: string;
  message?: string;
  variant?: "neutral" | "error";
}) {
  return (
    <div
      className={
        variant === "error"
          ? `${styles.state} ${styles.stateError}`
          : styles.state
      }
      role={variant === "error" ? "alert" : "status"}
    >
      <h2>{title}</h2>
      {message ? <p>{message}</p> : null}
    </div>
  );
}

export function WorkstreamsPage() {
  const { t } = useI18n();
  const { projectId } = useParams<{ projectId: string }>();
  const {
    settings,
    isLoading: settingsLoading,
    error: settingsError,
  } = useServerSettings();
  const { openSidebar, isWideScreen, toggleSidebar, isSidebarCollapsed } =
    useNavigationLayout();
  const [loadState, setLoadState] = useState<WorkstreamsLoadState>({
    status: "idle",
  });
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newWorkstreamLabel, setNewWorkstreamLabel] = useState("");
  const [previewState, setPreviewState] = useState<WorkstreamsPreviewState>({
    status: "idle",
  });
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const loadSequenceRef = useRef(0);
  const enabled = settings?.workstreamsEnabled === true;

  const loadWorkstreams = useCallback(
    async (options: { background?: boolean } = {}) => {
      if (!enabled || !projectId) {
        setLoadState({ status: "idle" });
        return;
      }

      const requestId = ++loadSequenceRef.current;
      setLoadState((current) =>
        options.background && current.status === "loaded"
          ? current
          : { status: "loading" },
      );

      try {
        const data = await api.getProjectWorkstreams(projectId);
        if (requestId !== loadSequenceRef.current) return;
        setLoadState({ status: "loaded", data });
      } catch (err) {
        if (requestId !== loadSequenceRef.current) return;
        setLoadState({
          status: "error",
          error: errorMessage(err, t("workstreamsLoadFailed")),
          statusCode: errorStatus(err),
        });
      }
    },
    [enabled, projectId, t],
  );

  useEffect(() => {
    void loadWorkstreams();
  }, [loadWorkstreams]);

  useEffect(() => {
    if (!enabled || !projectId) {
      return undefined;
    }

    return activityBus.on("workstreams-changed", (event) => {
      if (event.projectId === projectId) {
        void loadWorkstreams({ background: true });
      }
    });
  }, [enabled, loadWorkstreams, projectId]);

  useEffect(() => {
    const label = newWorkstreamLabel.trim();
    if (!showCreateForm || !enabled || !projectId || !label) {
      setPreviewState({ status: "idle" });
      return undefined;
    }

    let cancelled = false;
    setPreviewState({ status: "loading" });

    void api
      .getProjectWorkstreamCheckoutPreview(projectId, label)
      .then((data) => {
        if (cancelled) return;
        setPreviewState({ status: "loaded", data });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setPreviewState({
          status: "error",
          error: errorMessage(err, t("workstreamsPreviewFailed")),
          statusCode: errorStatus(err),
        });
      });

    return () => {
      cancelled = true;
    };
  }, [enabled, newWorkstreamLabel, projectId, showCreateForm, t]);

  const handleCreateSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!projectId || !enabled || creating) {
      return;
    }

    const label = newWorkstreamLabel.trim();
    if (!label) {
      return;
    }

    setCreating(true);
    setCreateError(null);

    try {
      const response = await api.createProjectWorkstream(projectId, { label });
      setLoadState({
        status: "loaded",
        data: {
          projectId: response.projectId,
          workstreams: response.workstreams,
        },
      });
      setShowCreateForm(false);
      setNewWorkstreamLabel("");
      setPreviewState({ status: "idle" });
    } catch (err) {
      const statusCode = errorStatus(err);
      if (statusCode === 409) {
        setCreateError(t("workstreamsCreateBusy"));
      } else {
        setCreateError(
          err instanceof Error ? err.message : t("workstreamsCreateFailed"),
        );
      }
    } finally {
      setCreating(false);
    }
  };

  const canShowCreate = enabled && Boolean(projectId);
  const canSubmitCreate =
    canShowCreate &&
    !creating &&
    newWorkstreamLabel.trim().length > 0 &&
    previewState.status === "loaded";

  const content = useMemo(() => {
    if (!projectId) {
      return (
        <WorkstreamsStateMessage
          title={t("workstreamsNoAccessTitle")}
          message={t("workstreamsNoAccessDescription")}
          variant="error"
        />
      );
    }

    if (settingsLoading && !settings) {
      return <p className="loading">{t("workstreamsLoading")}</p>;
    }

    if (settingsError && !settings) {
      return (
        <WorkstreamsStateMessage
          title={t("workstreamsSettingsErrorTitle")}
          message={settingsError}
          variant="error"
        />
      );
    }

    if (!enabled) {
      return (
        <WorkstreamsStateMessage
          title={t("workstreamsDisabledTitle")}
          message={t("workstreamsDisabledDescription")}
        />
      );
    }

    if (loadState.status === "idle" || loadState.status === "loading") {
      return <p className="loading">{t("workstreamsLoading")}</p>;
    }

    if (loadState.status === "error") {
      if (loadState.statusCode === 403 || loadState.statusCode === 404) {
        return (
          <WorkstreamsStateMessage
            title={t("workstreamsNoAccessTitle")}
            message={t("workstreamsNoAccessDescription")}
            variant="error"
          />
        );
      }

      return (
        <WorkstreamsStateMessage
          title={t("workstreamsErrorTitle")}
          message={loadState.error.message}
          variant="error"
        />
      );
    }

    if (loadState.status === "loaded") {
      return (
        <WorkstreamsTable workstreams={loadState.data.workstreams} t={t} />
      );
    }

    return <p className="loading">{t("workstreamsLoading")}</p>;
  }, [
    enabled,
    loadState,
    projectId,
    settings,
    settingsError,
    settingsLoading,
    t,
  ]);

  return (
    <MainContent
      isWideScreen={isWideScreen}
      innerClassName="workstreams-main-content"
    >
      <PageHeader
        title={t("workstreamsTitle")}
        onOpenSidebar={openSidebar}
        onToggleSidebar={toggleSidebar}
        isWideScreen={isWideScreen}
        isSidebarCollapsed={isSidebarCollapsed}
      />

      <main className="page-scroll-container">
        <div className={`page-content-inner ${styles.page}`}>
          {canShowCreate ? (
            <div className={styles.toolbar}>
              <button
                type="button"
                className={styles.actionButton}
                onClick={() => {
                  setShowCreateForm(true);
                  setCreateError(null);
                }}
                disabled={showCreateForm || creating}
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
                {t("workstreamsNewAction")}
              </button>
            </div>
          ) : null}

          {canShowCreate && showCreateForm ? (
            <WorkstreamCreateForm
              label={newWorkstreamLabel}
              previewState={previewState}
              creating={creating}
              createError={createError}
              canSubmit={canSubmitCreate}
              onLabelChange={(value) => {
                setNewWorkstreamLabel(value);
                setCreateError(null);
              }}
              onCancel={() => {
                if (creating) return;
                setShowCreateForm(false);
                setNewWorkstreamLabel("");
                setCreateError(null);
                setPreviewState({ status: "idle" });
              }}
              onSubmit={handleCreateSubmit}
              t={t}
            />
          ) : null}

          {content}
        </div>
      </main>
    </MainContent>
  );
}

function WorkstreamCreateForm({
  label,
  previewState,
  creating,
  createError,
  canSubmit,
  onLabelChange,
  onCancel,
  onSubmit,
  t,
}: {
  label: string;
  previewState: WorkstreamsPreviewState;
  creating: boolean;
  createError: string | null;
  canSubmit: boolean;
  onLabelChange: (value: string) => void;
  onCancel: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  t: ReturnType<typeof useI18n>["t"];
}) {
  return (
    <form className={styles.createForm} onSubmit={onSubmit}>
      <div className={styles.createField}>
        <label htmlFor="workstream-label-input">
          {t("workstreamsLabelLabel")}
        </label>
        <input
          id="workstream-label-input"
          type="text"
          value={label}
          onChange={(event) => onLabelChange(event.target.value)}
          placeholder={t("workstreamsLabelPlaceholder")}
          disabled={creating}
        />
      </div>

      <div className={styles.createPreview}>
        <span>{t("workstreamsDestinationLabel")}</span>
        {previewState.status === "loaded" ? (
          <code title={previewState.data.checkoutPath}>
            {previewState.data.checkoutPath}
          </code>
        ) : previewState.status === "loading" ? (
          <em>{t("workstreamsDestinationLoading")}</em>
        ) : previewState.status === "error" ? (
          <em className={styles.createError}>{previewState.error.message}</em>
        ) : (
          <em>{t("workstreamsDestinationPending")}</em>
        )}
      </div>

      {createError ? (
        <p className={styles.createError} role="alert">
          {createError}
        </p>
      ) : null}

      <div className={styles.createActions}>
        <button
          type="button"
          className={styles.secondaryButton}
          onClick={onCancel}
          disabled={creating}
        >
          {t("modalCancel")}
        </button>
        <button
          type="submit"
          className={styles.actionButton}
          disabled={!canSubmit}
        >
          {creating
            ? t("workstreamsCreatingAction")
            : t("workstreamsCreateAction")}
        </button>
      </div>
    </form>
  );
}

function WorkstreamsTable({
  workstreams,
  t,
}: {
  workstreams: Workstream[];
  t: ReturnType<typeof useI18n>["t"];
}) {
  if (workstreams.length === 0) {
    return (
      <WorkstreamsStateMessage
        title={t("workstreamsEmptyTitle")}
        message={t("workstreamsEmptyDescription")}
      />
    );
  }

  const checkoutCount = workstreams.filter(
    (workstream) => workstream.kind === "checkout",
  ).length;

  return (
    <>
      <div className={styles.tableWrapper}>
        <table className={styles.table} aria-label={t("workstreamsTableLabel")}>
          <thead>
            <tr>
              <th scope="col">{t("workstreamsColumnLane")}</th>
              <th scope="col">{t("workstreamsColumnKind")}</th>
              <th scope="col">{t("workstreamsColumnBranch")}</th>
              <th scope="col">{t("workstreamsColumnQueue")}</th>
              <th scope="col">{t("workstreamsColumnStatus")}</th>
              <th scope="col">{t("workstreamsColumnSessions")}</th>
              <th scope="col">{t("workstreamsColumnPath")}</th>
            </tr>
          </thead>
          <tbody>
            {workstreams.map((workstream) => (
              <WorkstreamsRow
                key={workstream.id}
                workstream={workstream}
                t={t}
              />
            ))}
          </tbody>
        </table>
      </div>
      {checkoutCount === 0 ? (
        <WorkstreamsStateMessage
          title={t("workstreamsNoCheckoutsTitle")}
          message={t("workstreamsNoCheckoutsDescription")}
        />
      ) : null}
    </>
  );
}

function WorkstreamsRow({
  workstream,
  t,
}: {
  workstream: Workstream;
  t: ReturnType<typeof useI18n>["t"];
}) {
  return (
    <tr>
      <th scope="row">
        <span className={styles.laneLabel}>{workstream.label}</span>
      </th>
      <td>
        <span className={styles.kind}>{kindLabel(workstream.kind, t)}</span>
      </td>
      <td>
        <code className={styles.branch}>
          {workstream.branch ?? t("workstreamsValueNone")}
        </code>
      </td>
      <td>
        <span
          className={
            workstream.queuePaused
              ? `${styles.badge} ${styles.badgePaused}`
              : `${styles.badge} ${styles.badgeRunning}`
          }
        >
          {workstream.queuePaused
            ? t("workstreamsQueuePaused")
            : t("workstreamsQueueRunning")}
        </span>
      </td>
      <td>
        <span className={styles.status}>
          {statusLabel(workstream.status, t)}
        </span>
      </td>
      <td aria-label={t("workstreamsSessionsUnavailable")}>
        <span className={styles.placeholder} aria-hidden="true">
          -
        </span>
      </td>
      <td>
        <code className={styles.path} title={workstream.path}>
          {workstream.path}
        </code>
      </td>
    </tr>
  );
}

function kindLabel(kind: WorkstreamKind, t: ReturnType<typeof useI18n>["t"]) {
  switch (kind) {
    case "main":
      return t("workstreamsKindMain");
    case "checkout":
      return t("workstreamsKindCheckout");
  }
}

function statusLabel(
  status: WorkstreamStatus,
  t: ReturnType<typeof useI18n>["t"],
) {
  switch (status) {
    case "active":
      return t("workstreamsStatusActive");
    case "archived":
      return t("workstreamsStatusArchived");
    case "landed":
      return t("workstreamsStatusLanded");
  }
}
