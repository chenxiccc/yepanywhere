import { Link, useParams } from "react-router-dom";
import { ProviderChildSessionDetail } from "../components/ProviderChildSessionDetail";
import { useRemoteBasePath } from "../hooks/useRemoteBasePath";
import { useI18n } from "../i18n";
import styles from "./ProviderChildSessionPage.module.css";

export function ProviderChildSessionPage() {
  const { t } = useI18n();
  const basePath = useRemoteBasePath();
  const { projectId, sessionId, agentId } = useParams<{
    projectId: string;
    sessionId: string;
    agentId: string;
  }>();

  if (!projectId || !sessionId || !agentId) {
    return (
      <div className={styles.page}>
        <p className={styles.status}>{t("providerChildPageInvalidUrl")}</p>
      </div>
    );
  }

  const parentHref = `${basePath}/projects/${projectId}/sessions/${sessionId}`;

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <Link className={styles.back} to={parentHref}>
          {t("providerChildPageBack")}
        </Link>
      </header>
      <main className={styles.main}>
        <ProviderChildSessionDetail
          key={agentId}
          projectId={projectId}
          sessionId={sessionId}
          agentId={agentId}
        />
      </main>
    </div>
  );
}
