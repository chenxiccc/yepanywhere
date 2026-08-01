import { useEffect, useMemo, useState } from "react";
import { api, type EnvSettingEntry } from "../../api/client";
import { useI18n } from "../../i18n";
import styles from "./EnvironmentSettings.module.css";
import { useSettingsPaneTitle } from "./SettingsPaneTitleContext";
import { HideInSettingsSearch } from "./SettingsSearchContext";
import { SettingsSection } from "./SettingsSection";

interface EnvGroup {
  group: string;
  entries: EnvSettingEntry[];
}

/** Preserve server registry order; group by `group` as groups first appear. */
function groupEntries(entries: EnvSettingEntry[]): EnvGroup[] {
  const groups: EnvGroup[] = [];
  const byName = new Map<string, EnvGroup>();
  for (const entry of entries) {
    let group = byName.get(entry.group);
    if (!group) {
      group = { group: entry.group, entries: [] };
      byName.set(entry.group, group);
      groups.push(group);
    }
    group.entries.push(entry);
  }
  return groups;
}

export function EnvironmentSettings() {
  const { t } = useI18n();
  useSettingsPaneTitle(t("environmentSectionTitle"));
  const [entries, setEntries] = useState<EnvSettingEntry[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .getEnvSettings()
      .then((report) => {
        if (!cancelled) setEntries(report.entries);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const groups = useMemo(
    () => (entries ? groupEntries(entries) : []),
    [entries],
  );

  return (
    <SettingsSection description={t("environmentSectionDescription")}>
      <HideInSettingsSearch>
        {error && (
          <p className="settings-warning">{t("environmentLoadError")}</p>
        )}
        {!error && entries === null && <p>{t("environmentLoading")}</p>}

        {groups.map((group) => (
          <div key={group.group} className={`settings-group ${styles.group}`}>
            <h3 className={styles.groupTitle}>{group.group}</h3>
            {group.entries.map((entry) => (
              <EnvVarRow key={entry.name} entry={entry} />
            ))}
          </div>
        ))}
      </HideInSettingsSearch>
    </SettingsSection>
  );
}

function EnvVarRow({ entry }: { entry: EnvSettingEntry }) {
  const { t } = useI18n();
  return (
    <div className={`${styles.row} ${entry.set ? "" : styles.unset}`}>
      <div className={styles.head}>
        <code className={styles.name}>{entry.name}</code>
        {entry.secret && (
          <span className={styles.secretBadge}>
            {t("environmentSecretBadge")}
          </span>
        )}
        <EnvVarValue entry={entry} />
      </div>
      <p className={styles.description}>{entry.description}</p>
      {entry.note && <p className={styles.note}>{entry.note}</p>}
    </div>
  );
}

function EnvVarValue({ entry }: { entry: EnvSettingEntry }) {
  const { t } = useI18n();
  if (!entry.set) {
    return (
      <span className={`${styles.value} ${styles.valueUnset}`}>
        {t("environmentValueNotSet")}
      </span>
    );
  }
  if (entry.value === "") {
    return (
      <span className={`${styles.value} ${styles.valueUnset}`}>
        {t("environmentValueEmpty")}
      </span>
    );
  }
  return <code className={styles.value}>{entry.value}</code>;
}
