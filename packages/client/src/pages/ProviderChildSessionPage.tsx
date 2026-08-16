import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../api/client";
import { TaskNestedContent } from "../components/renderers/tools/TaskNestedContent";
import { SessionMetadataProvider } from "../contexts/SessionMetadataContext";
import { useRemoteBasePath } from "../hooks/useRemoteBasePath";
import { useI18n } from "../i18n";
import type { AgentSession } from "../types";
import styles from "./ProviderChildSessionPage.module.css";

export function ProviderChildSessionPage() {
  const { t } = useI18n();
  const basePath = useRemoteBasePath();
  const { projectId, sessionId, agentId } = useParams<{
    projectId: string;
    sessionId: string;
    agentId: string;
  }>();
  const [content, setContent] = useState<AgentSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!projectId || !sessionId || !agentId) {
      setLoading(false);
      setError(t("providerChildPageInvalidUrl"));
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    void api
      .getAgentSession(projectId, sessionId, agentId)
      .then((data) => {
        if (!cancelled) {
          setContent(data);
        }
      })
      .catch((loadError: unknown) => {
        if (!cancelled) {
          setError(
            loadError instanceof Error
              ? loadError.message
              : t("providerChildPageNotFound"),
          );
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [agentId, projectId, sessionId, t]);

  if (!projectId || !sessionId || !agentId) {
    return (
      <div className={styles.page}>
        <p className={styles.status}>{t("providerChildPageInvalidUrl")}</p>
      </div>
    );
  }

  const parentHref = `${basePath}/projects/${projectId}/sessions/${sessionId}`;
  const title =
    content?.description || content?.agentType || t("providerChildFallback");

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <Link className={styles.back} to={parentHref}>
          {t("providerChildPageBack")}
        </Link>
        <div className={styles.heading}>
          <h1 className={styles.title}>{title}</h1>
          <div className={styles.meta}>
            {content?.agentType && content.agentType !== title && (
              <span>{content.agentType}</span>
            )}
            {content?.status && (
              <span>
                {t(
                  content.status === "running"
                    ? "providerChildStatusRunning"
                    : content.status === "completed"
                      ? "providerChildStatusCompleted"
                      : content.status === "failed"
                        ? "providerChildStatusFailed"
                        : "providerChildStatusPending",
                )}
              </span>
            )}
            {content?.spawnDepth !== undefined && (
              <span>
                {t("providerChildSpawnDepth", { count: content.spawnDepth })}
              </span>
            )}
          </div>
        </div>
        <p className={styles.readonly}>{t("providerChildPageReadOnly")}</p>
      </header>
      <main className={styles.main}>
        {loading && (
          <p className={styles.status}>{t("providerChildPageLoading")}</p>
        )}
        {!loading && error && <p className={styles.status}>{error}</p>}
        {!loading && !error && content && (
          <SessionMetadataProvider
            projectId={projectId}
            projectPath={null}
            sessionId={sessionId}
            sessionTitle={title}
          >
            {content.messages.length > 0 ? (
              <TaskNestedContent
                messages={content.messages}
                isStreaming={content.status === "running"}
              />
            ) : (
              <p className={styles.status}>{t("providerChildPageEmpty")}</p>
            )}
          </SessionMetadataProvider>
        )}
      </main>
    </div>
  );
}
