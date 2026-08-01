import { PageHeader } from "../components/PageHeader";
import { useHostIdentity } from "../contexts/HostIdentityContext";
import { useI18n } from "../i18n";
import { MainContent, useNavigationLayout } from "../layouts";
import styles from "./HostsPage.module.css";

function ServerGlyph({ icon }: { icon: string | null }) {
  if (icon) {
    return <span aria-hidden="true">{icon}</span>;
  }

  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="4" y="3.5" width="16" height="7" rx="2" />
      <rect x="4" y="13.5" width="16" height="7" rx="2" />
      <path d="M8 7h.01M8 17h.01" />
    </svg>
  );
}

function UnavailableRelationship({
  description,
}: {
  description: string;
}) {
  const { t } = useI18n();

  return (
    <div className={styles.unavailable} role="status">
      <strong>{t("hostsPreviewUnavailableTitle")}</strong>
      <p>{description}</p>
    </div>
  );
}

export function HostsPage() {
  const { t } = useI18n();
  const { icon } = useHostIdentity();
  const { openSidebar, isWideScreen, toggleSidebar, isSidebarCollapsed } =
    useNavigationLayout();

  return (
    <MainContent isWideScreen={isWideScreen}>
      <PageHeader
        title={t("hostsTitle")}
        onOpenSidebar={openSidebar}
        onToggleSidebar={toggleSidebar}
        isWideScreen={isWideScreen}
        isSidebarCollapsed={isSidebarCollapsed}
        actions={<span className={styles.badge}>{t("hostsExperimental")}</span>}
      />

      <main className="page-scroll-container" data-testid="hosts-page">
        <div className={`page-content-inner ${styles.content}`}>
          <p className={styles.lede}>{t("hostsDescription")}</p>

          <section className={styles.section}>
            <h2>{t("hostsCurrentSection")}</h2>
            <article className={styles.currentCard}>
              <div className={styles.currentHeader}>
                <span className={styles.serverGlyph}>
                  <ServerGlyph icon={icon} />
                </span>
                <div className={styles.currentIdentity}>
                  <h3>{t("hostsCurrentName")}</h3>
                  <p>{t("hostsCurrentDescription")}</p>
                </div>
                <span className={styles.currentBadge}>
                  {t("hostsCurrentStatus")}
                </span>
              </div>
            </article>
          </section>

          <aside className={styles.accessNote}>
            <h2>{t("hostsAccessPathsTitle")}</h2>
            <p>{t("hostsAccessPathsDescription")}</p>
            <p>{t("hostsSavedHostsNote")}</p>
          </aside>

          <div className={styles.relationshipGrid}>
            <section className={styles.section}>
              <h2>{t("hostsOutgoingTitle")}</h2>
              <p className={styles.sectionDescription}>
                {t("hostsOutgoingDescription")}
              </p>
              <UnavailableRelationship
                description={t("hostsOutgoingUnavailableDescription")}
              />
            </section>

            <section className={styles.section}>
              <h2>{t("hostsIncomingTitle")}</h2>
              <p className={styles.sectionDescription}>
                {t("hostsIncomingDescription")}
              </p>
              <UnavailableRelationship
                description={t("hostsIncomingUnavailableDescription")}
              />
            </section>
          </div>
        </div>
      </main>
    </MainContent>
  );
}
