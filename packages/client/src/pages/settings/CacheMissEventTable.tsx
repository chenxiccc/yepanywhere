import type { CacheMissBillingRecord } from "@yep-anywhere/shared";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { MessageAge } from "../../components/MessageAge";
import { useRelativeNow } from "../../hooks/useRelativeNow";
import { useI18n } from "../../i18n";
import styles from "./CacheMissEventTable.module.css";

interface EventGroup {
  key: string;
  tuple: string;
  events: CacheMissBillingRecord[];
  misses: number;
  newestTimestampMs: number;
}

function eventTuple(event: CacheMissBillingRecord, unknownModel: string) {
  return `${event.provider} / ${event.model?.trim() || unknownModel}`;
}

export function groupCacheMissEvents(
  events: CacheMissBillingRecord[],
  unknownModel: string,
): EventGroup[] {
  const groups = new Map<string, EventGroup>();
  for (const event of events) {
    const tuple = eventTuple(event, unknownModel);
    const timestampMs = Date.parse(event.timestamp);
    const group = groups.get(tuple) ?? {
      key: tuple,
      tuple,
      events: [],
      misses: 0,
      newestTimestampMs: 0,
    };
    group.events.push(event);
    if (event.outcome === "unexpected-recompute") group.misses += 1;
    if (Number.isFinite(timestampMs)) {
      group.newestTimestampMs = Math.max(group.newestTimestampMs, timestampMs);
    }
    groups.set(tuple, group);
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      events: group.events.sort((a, b) =>
        b.timestamp.localeCompare(a.timestamp),
      ),
    }))
    .sort((a, b) => b.newestTimestampMs - a.newestTimestampMs);
}

function formatTokenCount(tokens: number): string {
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 0,
  }).format(tokens);
}

function eventTokenCount(event: CacheMissBillingRecord): number {
  return event.outcome === "unexpected-recompute"
    ? event.wastedInputTokens
    : (event.observedUsage.cacheReadTokens ?? 0);
}

function formatIdleDuration(elapsedMs: number | undefined): string {
  if (elapsedMs === undefined) return "—";
  if (elapsedMs < 60_000) return "<1m";
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

function eventMessageReference(event: CacheMissBillingRecord): string {
  if (event.messageIndex !== undefined) return `#${event.messageIndex}`;
  if (event.messageId) {
    return event.messageId.length > 8
      ? `${event.messageId.slice(0, 8)}…`
      : event.messageId;
  }
  return "—";
}

export function CacheMissEventTable({
  events,
  basePath,
  recencyHours,
}: {
  events: CacheMissBillingRecord[];
  basePath: string;
  recencyHours: number | null;
}) {
  const { t } = useI18n();
  const nowMs = useRelativeNow(60_000);
  const [tupleFilter, setTupleFilter] = useState("");
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(
    () => new Set(),
  );
  const groups = useMemo(() => {
    const query = tupleFilter.trim().toLocaleLowerCase();
    return groupCacheMissEvents(events, t("cacheMissUnknownModel")).filter(
      (group) => !query || group.tuple.toLocaleLowerCase().includes(query),
    );
  }, [events, t, tupleFilter]);

  const toggleGroup = (key: string) => {
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const shownEventCount = groups.reduce(
    (sum, group) => sum + group.events.length,
    0,
  );
  const visibleCountLabel =
    recencyHours === null
      ? t("cacheMissEventVisibleCount", {
          shown: shownEventCount,
          total: events.length,
        })
      : t("cacheMissEventVisibleCountRecent", {
          shown: shownEventCount,
          total: events.length,
          hours: recencyHours,
        });

  return (
    <div className={styles.viewer}>
      <div className={styles.toolbar}>
        <label className={styles.filterLabel}>
          <span>{t("cacheMissEventFilterLabel")}</span>
          <input
            type="search"
            value={tupleFilter}
            onChange={(event) => setTupleFilter(event.currentTarget.value)}
            placeholder={t("cacheMissEventFilterPlaceholder")}
          />
        </label>
        <span className={styles.matchCount}>{visibleCountLabel}</span>
      </div>

      {groups.length === 0 ? (
        <p className="settings-empty">
          {events.length === 0
            ? t("cacheMissBillingEventsEmpty")
            : t("cacheMissEventFilterEmpty")}
        </p>
      ) : (
        <div className={styles.scroller}>
          <table className={styles.table}>
            <colgroup>
              <col className={styles.tupleColumn} />
              <col className={styles.seenColumn} />
              <col className={styles.resultColumn} />
              <col className={styles.gapColumn} />
              <col className={styles.tokensColumn} />
              <col className={styles.kindColumn} />
              <col className={styles.messageColumn} />
              <col className={styles.openColumn} />
            </colgroup>
            <thead>
              <tr>
                <th title={t("cacheMissEventTupleHeaderTitle")}>
                  {t("cacheMissEventTupleHeader")}
                </th>
                <th title={t("cacheMissEventAgeHeaderTitle")}>
                  {t("cacheMissEventAgeHeader")}
                </th>
                <th title={t("cacheMissEventResultHeaderTitle")}>
                  {t("cacheMissEventResultHeader")}
                </th>
                <th title={t("cacheMissEventIdleHeaderTitle")}>
                  {t("cacheMissEventIdleHeader")}
                </th>
                <th title={t("cacheMissEventTokensHeaderTitle")}>
                  {t("cacheMissEventTokensHeader")}
                </th>
                <th title={t("cacheMissEventKindHeaderTitle")}>
                  {t("cacheMissEventKindHeader")}
                </th>
                <th title={t("cacheMissEventMessageHeaderTitle")}>
                  {t("cacheMissEventMessageHeader")}
                </th>
                <th title={t("cacheMissEventSessionHeaderTitle")}>
                  {t("cacheMissEventSessionHeader")}
                </th>
              </tr>
            </thead>
            {groups.map((group) => {
              const collapsed = collapsedGroups.has(group.key);
              return (
                <tbody key={group.key}>
                  <tr className={styles.groupRow}>
                    <th scope="rowgroup">
                      <button
                        type="button"
                        className={styles.groupButton}
                        aria-expanded={!collapsed}
                        aria-label={t(
                          collapsed
                            ? "cacheMissEventExpandGroup"
                            : "cacheMissEventCollapseGroup",
                          { tuple: group.tuple },
                        )}
                        onClick={() => toggleGroup(group.key)}
                      >
                        <span aria-hidden="true">{collapsed ? "▸" : "▾"}</span>
                        <span>{group.tuple}</span>
                      </button>
                    </th>
                    <td colSpan={7} className={styles.groupSummary}>
                      {t("cacheMissEventGroupSummary", {
                        count: group.events.length,
                        misses: group.misses,
                      })}
                      {group.newestTimestampMs > 0 && (
                        <>
                          {" · "}
                          <MessageAge
                            timestampMs={group.newestTimestampMs}
                            nowMs={nowMs}
                            className={styles.age}
                            formatLabel={(age) =>
                              age === "now"
                                ? t("cacheMissEventNewestNow")
                                : t("cacheMissEventNewestAge", { age })
                            }
                          />
                        </>
                      )}
                    </td>
                  </tr>
                  {!collapsed &&
                    group.events.map((event) => (
                      <tr className={styles.eventRow} key={event.id}>
                        <td aria-hidden="true" />
                        <td>
                          <MessageAge
                            timestampMs={Date.parse(event.timestamp)}
                            nowMs={nowMs}
                            className={styles.age}
                            formatLabel={(age) =>
                              age === "now"
                                ? t("cacheMissEventAgeNow")
                                : t("cacheMissEventAgeAgo", { age })
                            }
                          />
                        </td>
                        <td
                          className={
                            event.outcome === "unexpected-recompute"
                              ? styles.miss
                              : styles.hit
                          }
                        >
                          {event.outcome === "unexpected-recompute"
                            ? t("cacheMissEventResultMiss")
                            : t("cacheMissEventResultHit")}
                        </td>
                        <td>
                          {formatIdleDuration(
                            event.elapsedSinceExpectedCacheMs,
                          )}
                        </td>
                        <td className={styles.numeric}>
                          {formatTokenCount(eventTokenCount(event))}
                        </td>
                        <td>
                          {event.expectedCacheSource === "fork"
                            ? t("cacheMissEventKindFork")
                            : t("cacheMissEventKindWarm")}
                        </td>
                        <td
                          className={styles.messageReference}
                          title={event.messageId}
                        >
                          {eventMessageReference(event)}
                        </td>
                        <td>
                          <Link
                            className={styles.openLink}
                            to={`${basePath}${event.sessionPath}`}
                            title={t("cacheMissBillingOpenSession")}
                          >
                            {t("cacheMissEventOpen")}
                          </Link>
                        </td>
                      </tr>
                    ))}
                </tbody>
              );
            })}
          </table>
        </div>
      )}
    </div>
  );
}
