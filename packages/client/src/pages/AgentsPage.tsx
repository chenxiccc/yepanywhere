import type { HostAgentProcessObservation } from "@yep-anywhere/shared";
import {
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import { ContextUsageIndicator } from "../components/ContextUsageIndicator";
import { PageHeader } from "../components/PageHeader";
import { ThinkingIndicator } from "../components/ThinkingIndicator";
import { useHostAgentProcesses } from "../hooks/useHostAgentProcesses";
import { type ProcessInfo, useProcesses } from "../hooks/useProcesses";
import { useRemoteBasePath } from "../hooks/useRemoteBasePath";
import { useI18n } from "../i18n";
import { MainContent, useNavigationLayout } from "../layouts";

/**
 * Format uptime duration from start time to now.
 */
function formatUptime(startedAt: string): string {
  const start = new Date(startedAt).getTime();
  const now = Date.now();
  const diffMs = now - start;

  const seconds = Math.floor(diffMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return `${days}d ${hours % 24}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}

function formatMemory(bytes: number): string {
  const mebibytes = bytes / (1024 * 1024);
  if (mebibytes < 1024) {
    return `${Math.round(mebibytes)} MiB`;
  }
  const gibibytes = mebibytes / 1024;
  return `${gibibytes < 10 ? gibibytes.toFixed(1) : Math.round(gibibytes)} GiB`;
}

function formatCpu(percent: number): string {
  return `${percent < 10 ? percent.toFixed(1) : Math.round(percent)}%`;
}

/**
 * Get a display label for the process state.
 */
function getStateLabel(state: string, t: (key: never) => string): string {
  switch (state) {
    case "running":
      return t("agentsRunning" as never);
    case "waiting-input":
      return t("agentsNeedsInput" as never);
    case "idle":
      return t("agentsIdle" as never);
    case "terminated":
      return t("agentsStopped" as never);
    default:
      return state;
  }
}

/**
 * Get CSS class for state badge.
 */
function getStateBadgeClass(state: string): string {
  switch (state) {
    case "running":
      return "agent-state-running";
    case "waiting-input":
      return "agent-state-input";
    case "idle":
      return "agent-state-idle";
    case "terminated":
      return "agent-state-terminated";
    default:
      return "";
  }
}

/**
 * Get display name for provider.
 */
function getProviderLabel(
  provider: string | undefined,
  t: (key: never) => string,
): string {
  switch (provider) {
    case "claude":
      return "Claude";
    case "claude-gateway":
      return "Claude Gateway";
    case "claude-ollama":
      return "Claude + Ollama";
    case "codex":
      return "Codex";
    case "gemini":
    case "gemini-acp":
      return "Gemini";
    case "grok":
      return "Grok";
    case "opencode":
      return "OpenCode";
    case "pi":
      return "Pi";
    case "local":
      return t("agentsProviderLocal" as never);
    default:
      return provider ?? "Claude";
  }
}

/**
 * Get CSS class for provider badge.
 */
function getProviderBadgeClass(provider: string | undefined): string {
  switch (provider) {
    case "codex":
      return "agent-provider-codex";
    case "gemini":
    case "gemini-acp":
      return "agent-provider-gemini";
    case "grok":
      return "agent-provider-grok";
    case "opencode":
      return "agent-provider-opencode";
    case "pi":
      return "agent-provider-pi";
    case "local":
      return "agent-provider-local";
    default:
      return "agent-provider-claude";
  }
}

interface ProcessCardProps {
  process: ProcessInfo;
  observation?: HostAgentProcessObservation;
  basePath?: string;
  isTerminated?: boolean;
  onKill?: (process: ProcessInfo) => void;
  killing?: boolean;
}

interface KillFeedback {
  tone: "success" | "error";
  message: string;
}

interface ProcessMetricsProps {
  observation: HostAgentProcessObservation;
  touchSurfaceRef?: RefObject<HTMLElement | null>;
}

function ProcessMetrics({
  observation,
  touchSurfaceRef,
}: ProcessMetricsProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLSpanElement>(null);
  const provider = getProviderLabel(observation.provider, t);
  const age = formatUptime(observation.startedAt);
  const cpu = observation.cpu
    ? t("agentsMetricsCpuValue" as never, {
        percent: formatCpu(observation.cpu.treePercent),
      })
    : t("agentsMetricsCpuSampling" as never);
  const detail = [
    t(
      (observation.supervision === "ya"
        ? "agentsMetricsManagedYa"
        : "agentsMetricsManagedExternal") as never,
    ),
    t("agentsMetricsProvider" as never, { provider }),
    t("agentsPid" as never, { pid: observation.pid }),
    t("agentsMetricsStarted" as never, {
      value: new Date(observation.startedAt).toLocaleString(),
    }),
    t("agentsMetricsAge" as never, { value: age }),
    observation.cpu
      ? t("agentsMetricsRecentCpu" as never, {
          percent: formatCpu(observation.cpu.rootPercent),
          treePercent: formatCpu(observation.cpu.treePercent),
          seconds: (observation.cpu.windowMs / 1000).toFixed(1),
        })
      : t("agentsMetricsCpuSampling" as never),
    t("agentsMetricsRootRss" as never, {
      value: formatMemory(observation.memory.rootRssBytes),
    }),
    t("agentsMetricsTreeRss" as never, {
      value: formatMemory(observation.memory.treeRssBytes),
    }),
    t("agentsMetricsDescendants" as never, {
      count: observation.memory.descendantCount,
    }),
    t("agentsMetricsSampled" as never, {
      value: new Date(observation.sampledAt).toLocaleTimeString(),
    }),
  ].join("\n");

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return;
      const isTouchOnCard =
        event.pointerType === "touch" &&
        touchSurfaceRef?.current?.contains(event.target);
      if (!wrapperRef.current?.contains(event.target) && !isTouchOnCard) {
        setOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, touchSurfaceRef]);

  useEffect(() => {
    const touchSurface = touchSurfaceRef?.current;
    if (!touchSurface) return;
    const handlePointerUp = (event: PointerEvent) => {
      if (
        event.pointerType !== "touch" ||
        !(event.target instanceof Node) ||
        wrapperRef.current?.contains(event.target)
      ) {
        return;
      }
      const interactiveTarget =
        event.target instanceof Element
          ? event.target.closest(
              "a, button, input, select, textarea, [role='button'], [role='link']",
            )
          : null;
      if (!interactiveTarget) setOpen((value) => !value);
    };
    touchSurface.addEventListener("pointerup", handlePointerUp);
    return () => {
      touchSurface.removeEventListener("pointerup", handlePointerUp);
    };
  }, [touchSurfaceRef]);

  return (
    <span
      className={`agent-metrics-wrap${open ? " agent-metrics-wrap-open" : ""}`}
      ref={wrapperRef}
    >
      <button
        type="button"
        className="agent-metrics"
        title={detail}
        aria-label={detail}
        aria-expanded={open}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setOpen((value) => !value);
        }}
      >
        <span>{formatMemory(observation.memory.rootRssBytes)} RSS</span>
        <span aria-hidden>·</span>
        <span>{cpu}</span>
      </button>
      {open && (
        <span className="agent-metrics-popover" role="status">
          {detail}
        </span>
      )}
    </span>
  );
}

function ProcessCard({
  process,
  observation,
  basePath = "",
  isTerminated = false,
  onKill,
  killing = false,
}: ProcessCardProps) {
  const { t } = useI18n();
  const providerChildren = process.providerChildren ?? [];
  return (
    <Link
      to={`${basePath}/projects/${process.projectId}/sessions/${process.sessionId}`}
      className={`agent-card ${isTerminated ? "agent-card-terminated" : ""}`}
    >
      <div className="agent-card-header">
        <div className="agent-card-title">
          <span className="agent-card-session-title">
            {process.sessionTitle || t("agentsUntitled" as never)}
          </span>
          <span
            className={`agent-provider-badge ${getProviderBadgeClass(process.provider)}`}
          >
            {getProviderLabel(process.provider, t)}
          </span>
          {process.state === "in-turn" ? (
            <ThinkingIndicator
              variant="pill"
              label={t("agentsRunning" as never)}
            />
          ) : (
            <span
              className={`agent-state-badge ${getStateBadgeClass(process.state)}`}
            >
              {getStateLabel(process.state, t)}
            </span>
          )}
          {!isTerminated && onKill && (
            <button
              type="button"
              className="agent-kill-button"
              disabled={killing}
              onClick={(e) => {
                // The whole card is a Link; keep a kill tap from navigating.
                e.preventDefault();
                e.stopPropagation();
                onKill(process);
              }}
              title={t("agentsKillTitle" as never)}
            >
              {killing ? t("agentsKilling" as never) : t("agentsKill" as never)}
            </button>
          )}
        </div>
        <div className="agent-card-meta">
          <span className="agent-card-project">{process.projectName}</span>
          {process.pid !== undefined && (
            <span className="agent-card-pid">
              {t("agentsPid" as never, { pid: process.pid })}
            </span>
          )}
          {!isTerminated && (
            <span className="agent-card-uptime">
              {formatUptime(process.startedAt)}
            </span>
          )}
          {!isTerminated && observation && (
            <ProcessMetrics observation={observation} />
          )}
          {process.contextUsage && (
            <ContextUsageIndicator usage={process.contextUsage} />
          )}
        </div>
      </div>

      {(process.permissionMode ||
        process.queueDepth > 0 ||
        process.terminationReason) && (
        <div className="agent-card-details">
          {process.permissionMode && (
            <div className="agent-detail-row">
              <span className="agent-detail-label">
                {t("agentsPermissionMode" as never)}
              </span>
              <span className="agent-detail-value">
                {process.permissionMode}
              </span>
            </div>
          )}
          {process.queueDepth > 0 && (
            <div className="agent-detail-row">
              <span className="agent-detail-label">
                {t("agentsMessagesQueued" as never)}
              </span>
              <span className="agent-detail-value">{process.queueDepth}</span>
            </div>
          )}
          {process.terminationReason && (
            <div className="agent-detail-row">
              <span className="agent-detail-label">
                {t("agentsStopReason" as never)}
              </span>
              <span className="agent-detail-value">
                {process.terminationReason}
              </span>
            </div>
          )}
        </div>
      )}

      {providerChildren.length > 0 && (
        <div
          className="agent-provider-children"
          role="list"
          aria-label={t(
            (providerChildren.length === 1
              ? "providerChildrenCountOne"
              : "providerChildrenCountMany") as never,
            { count: providerChildren.length },
          )}
        >
          {providerChildren.map((child) => {
            const childTitle =
              child.title ||
              child.agentType ||
              t("providerChildFallback" as never);
            return (
              <div
                className="agent-provider-child"
                key={child.id}
                role="listitem"
              >
                <span className="agent-provider-child-branch" aria-hidden>
                  ↳
                </span>
                <span className="agent-provider-child-title">
                  {childTitle}
                </span>
                {child.agentType && child.agentType !== childTitle && (
                  <span className="agent-provider-child-type">
                    {child.agentType}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Link>
  );
}

function ExternalProcessCard({
  observation,
}: {
  observation: HostAgentProcessObservation;
}) {
  const { t } = useI18n();
  const provider = getProviderLabel(observation.provider, t);
  const touchSurfaceRef = useRef<HTMLElement>(null);
  return (
    <article
      className="agent-card agent-card-external"
      ref={touchSurfaceRef}
    >
      <div className="agent-card-header">
        <div className="agent-card-title">
          <span className="agent-card-session-title">
            {t("agentsExternalProcessTitle" as never, { provider })}
          </span>
          <span
            className={`agent-provider-badge ${getProviderBadgeClass(observation.provider)}`}
          >
            {provider}
          </span>
          <span className="agent-state-badge agent-state-external">
            {t("agentsOutsideYa" as never)}
          </span>
        </div>
        <div className="agent-card-meta">
          <span className="agent-card-pid">
            {t("agentsPid" as never, { pid: observation.pid })}
          </span>
          <span className="agent-card-uptime">
            {formatUptime(observation.startedAt)}
          </span>
          <ProcessMetrics
            observation={observation}
            touchSurfaceRef={touchSurfaceRef}
          />
        </div>
      </div>
    </article>
  );
}

export function AgentsPage() {
  const { t } = useI18n();
  const { processes, terminatedProcesses, loading, error, refetch } =
    useProcesses();
  const basePath = useRemoteBasePath();
  const hostProcesses = useHostAgentProcesses();

  const { openSidebar, isWideScreen } = useNavigationLayout();

  const [killingIds, setKillingIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [killFeedback, setKillFeedback] = useState<KillFeedback | null>(null);

  // Forcibly abort a live (hung or otherwise) process. This is the manual
  // escape hatch for orphans the automatic stale sweep can't confirm dead
  // (e.g. a Codex hang with no liveness signal), which otherwise sit on the
  // Active list with no UI recourse.
  const handleKill = useCallback(
    async (process: ProcessInfo) => {
      const label = process.sessionTitle || t("agentsUntitled" as never);
      if (!window.confirm(t("agentsKillConfirm" as never, { title: label }))) {
        return;
      }
      setKillingIds((prev) => new Set(prev).add(process.id));
      setKillFeedback(null);
      try {
        // Explicit Kill also persists a YA-owned auto-resume exemption. The
        // provider transcript remains available for deliberate continuation.
        const result = await api.abortProcess(process.id, {
          blockResume: true,
        });
        const stopped =
          result.pid === undefined
            ? t("agentsKillVerified" as never)
            : t("agentsKillVerifiedPid" as never, { pid: result.pid });
        const exemption = result.resumeExemption;
        if (exemption?.error || exemption?.autoResumeDisabled === false) {
          setKillFeedback({
            tone: "error",
            message: `${stopped} ${t("agentsKillResumeBlockFailed" as never, {
              message:
                exemption.error ?? t("agentsKillResumeBlockUnknown" as never),
            })}`,
          });
        } else {
          const resumeBlocked = exemption?.autoResumeDisabled
            ? ` ${t("agentsKillResumeBlocked" as never)}`
            : "";
          setKillFeedback({
            tone: "success",
            message: `${stopped}${resumeBlocked}`,
          });
        }
      } catch (error) {
        setKillFeedback({
          tone: "error",
          message: t("agentsKillFailed" as never, {
            message: error instanceof Error ? error.message : String(error),
          }),
        });
      } finally {
        await refetch();
        setKillingIds((prev) => {
          const next = new Set(prev);
          next.delete(process.id);
          return next;
        });
      }
    },
    [refetch, t],
  );

  // Split processes into active (in-turn/waiting-input) and idle
  const activeProcesses = processes.filter(
    (p) => p.state === "in-turn" || p.state === "waiting-input",
  );
  const idleProcesses = processes.filter((p) => p.state === "idle");
  const observationsBySupervisorProcessId = useMemo(
    () =>
      new Map(
        hostProcesses.observations
          .filter(
            (
              observation,
            ): observation is HostAgentProcessObservation & {
              supervisorProcessId: string;
            } => observation.supervisorProcessId !== undefined,
          )
          .map((observation) => [observation.supervisorProcessId, observation]),
      ),
    [hostProcesses.observations],
  );
  const externalProcesses = hostProcesses.observations.filter(
    (observation) => observation.supervision === "external",
  );

  return (
    <MainContent isWideScreen={isWideScreen}>
      <PageHeader
        title={t("agentsTitle" as never)}
        onOpenSidebar={openSidebar}
      />

      <main className="page-scroll-container">
        <div className="page-content-inner">
          {loading && <p className="loading">{t("agentsLoading" as never)}</p>}

          {error && (
            <p className="error">
              {t("agentsError" as never, { message: error.message })}
            </p>
          )}

          {killFeedback && (
            <p
              className={`agents-kill-feedback agents-kill-feedback-${killFeedback.tone}`}
              role={killFeedback.tone === "error" ? "alert" : "status"}
            >
              {killFeedback.message}
            </p>
          )}

          {!loading && !error && (
            <>
              <section className="agents-section">
                <h2>{t("agentsSectionActive" as never)}</h2>
                {activeProcesses.length === 0 ? (
                  <p className="agents-empty">
                    {t("agentsEmptyActive" as never)}
                  </p>
                ) : (
                  <div className="agents-list">
                    {activeProcesses.map((process) => (
                      <ProcessCard
                        key={process.id}
                        process={process}
                        observation={observationsBySupervisorProcessId.get(
                          process.id,
                        )}
                        basePath={basePath}
                        onKill={handleKill}
                        killing={killingIds.has(process.id)}
                      />
                    ))}
                  </div>
                )}
              </section>

              {hostProcesses.enabled && (
                <section className="agents-section">
                  <h2>{t("agentsSectionExternal" as never)}</h2>
                  {hostProcesses.loading ? (
                    <p className="agents-empty">
                      {t("agentsExternalLoading" as never)}
                    </p>
                  ) : hostProcesses.supported === false ? (
                    <p className="agents-empty">
                      {t("agentsExternalUnsupported" as never)}
                    </p>
                  ) : hostProcesses.error ? (
                    <p className="agents-empty">
                      {t("agentsExternalUnavailable" as never)}
                    </p>
                  ) : externalProcesses.length === 0 ? (
                    <p className="agents-empty">
                      {t("agentsEmptyExternal" as never)}
                    </p>
                  ) : (
                    <div className="agents-list">
                      {externalProcesses.map((observation) => (
                        <ExternalProcessCard
                          key={observation.observationId}
                          observation={observation}
                        />
                      ))}
                    </div>
                  )}
                </section>
              )}

              <section className="agents-section">
                <h2>{t("agentsSectionIdle" as never)}</h2>
                {idleProcesses.length === 0 ? (
                  <p className="agents-empty">
                    {t("agentsEmptyIdle" as never)}
                  </p>
                ) : (
                  <div className="agents-list">
                    {idleProcesses.map((process) => (
                      <ProcessCard
                        key={process.id}
                        process={process}
                        observation={observationsBySupervisorProcessId.get(
                          process.id,
                        )}
                        basePath={basePath}
                        onKill={handleKill}
                        killing={killingIds.has(process.id)}
                      />
                    ))}
                  </div>
                )}
              </section>

              <section className="agents-section">
                <h2>{t("agentsSectionStopped" as never)}</h2>
                {terminatedProcesses.length === 0 ? (
                  <p className="agents-empty">
                    {t("agentsEmptyStopped" as never)}
                  </p>
                ) : (
                  <div className="agents-list">
                    {terminatedProcesses.map((process) => (
                      <ProcessCard
                        key={process.id}
                        process={process}
                        basePath={basePath}
                        isTerminated
                      />
                    ))}
                  </div>
                )}
              </section>
            </>
          )}
        </div>
      </main>
    </MainContent>
  );
}
