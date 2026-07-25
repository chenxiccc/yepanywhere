import { useEffect, useMemo, useState } from "react";
import { api, type EnvSettingEntry } from "../../api/client";
import { useI18n } from "../../i18n";
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
          <div key={group.group} className="settings-group env-var-group">
            <h3 className="env-var-group-title">{group.group}</h3>
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
    <div className={`env-var-row ${entry.set ? "" : "env-var-unset"}`}>
      <div className="env-var-head">
        <code className="env-var-name">{entry.name}</code>
        {entry.secret && (
          <span className="env-var-secret-badge">
            {t("environmentSecretBadge")}
          </span>
        )}
        <EnvVarValue entry={entry} />
      </div>
      <p className="env-var-description">{entry.description}</p>
      {entry.note && <p className="env-var-note">{entry.note}</p>}
    </div>
  );
}

function EnvVarValue({ entry }: { entry: EnvSettingEntry }) {
  const { t } = useI18n();
  if (!entry.set) {
    return (
      <span className="env-var-value env-var-value-unset">
        {t("environmentValueNotSet")}
      </span>
    );
  }
  if (entry.value === "") {
    return (
      <span className="env-var-value env-var-value-unset">
        {t("environmentValueEmpty")}
      </span>
    );
  }
  return <code className="env-var-value">{entry.value}</code>;
}
