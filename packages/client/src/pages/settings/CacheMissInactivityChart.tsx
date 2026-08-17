import type { CacheMissBillingRecord } from "@yep-anywhere/shared";
import { useI18n } from "../../i18n";
import styles from "./CacheMissInactivityChart.module.css";

/**
 * Minute buckets for the inactivity axis. Cache lifetimes are discussed in
 * minutes and the interesting structure is at the short end — a miss two
 * minutes after the last turn means something quite different from one at two
 * hours — so the buckets are fine early and coarse later.
 */
const BUCKET_EDGES_MINUTES = [1, 2, 5, 10, 20, 30, 60, 120] as const;

export interface InactivityBucket {
  /** Inclusive lower edge in minutes. */
  fromMinutes: number;
  /** Exclusive upper edge in minutes; undefined for the final open bucket. */
  toMinutes?: number;
  misses: number;
  hits: number;
  wastedTokens: number;
}

export function bucketByInactivity(
  events: CacheMissBillingRecord[],
): InactivityBucket[] {
  const buckets: InactivityBucket[] = [];
  let previousEdge = 0;
  for (const edge of BUCKET_EDGES_MINUTES) {
    buckets.push({
      fromMinutes: previousEdge,
      toMinutes: edge,
      misses: 0,
      hits: 0,
      wastedTokens: 0,
    });
    previousEdge = edge;
  }
  buckets.push({
    fromMinutes: previousEdge,
    misses: 0,
    hits: 0,
    wastedTokens: 0,
  });

  for (const event of events) {
    if (event.elapsedSinceExpectedCacheMs === undefined) continue;
    const minutes = event.elapsedSinceExpectedCacheMs / 60_000;
    const bucket =
      buckets.find(
        (candidate) =>
          candidate.toMinutes !== undefined && minutes < candidate.toMinutes,
      ) ?? buckets[buckets.length - 1];
    if (!bucket) continue;
    if (event.outcome === "unexpected-recompute") {
      bucket.misses += 1;
      bucket.wastedTokens += event.wastedInputTokens;
    } else {
      bucket.hits += 1;
    }
  }
  return buckets;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(tokens);
}

function bucketLabel(bucket: InactivityBucket): string {
  if (bucket.toMinutes === undefined) return `${bucket.fromMinutes}m+`;
  if (bucket.fromMinutes === 0) return `<${bucket.toMinutes}m`;
  return `${bucket.fromMinutes}–${bucket.toMinutes}m`;
}

/**
 * Where re-reads actually happen, by how long the session sat idle first.
 * Bar length is the tokens a warm cache should have served; the count beside
 * it is misses over observations, so a bucket with one miss in twenty reads
 * differently from one where every turn missed.
 */
export function CacheMissInactivityChart({
  events,
}: {
  events: CacheMissBillingRecord[];
}) {
  const { t } = useI18n();
  const buckets = bucketByInactivity(events).filter(
    (bucket) => bucket.misses > 0 || bucket.hits > 0,
  );
  if (buckets.length === 0) {
    return <p className="settings-empty">{t("cacheMissChartEmpty")}</p>;
  }

  const peak = Math.max(...buckets.map((bucket) => bucket.wastedTokens), 1);
  const totalWasted = buckets.reduce(
    (sum, bucket) => sum + bucket.wastedTokens,
    0,
  );

  return (
    <div className={styles.chart}>
      <p className="settings-hint">
        {t("cacheMissChartTotal", { tokens: formatTokens(totalWasted) })}
      </p>
      <ol className={styles.bars}>
        {buckets.map((bucket) => (
          <li className={styles.bar} key={bucket.fromMinutes}>
            <span className={styles.barLabel}>{bucketLabel(bucket)}</span>
            <span className={styles.barTrack}>
              <span
                className={styles.barFill}
                style={{
                  width: `${Math.round((bucket.wastedTokens / peak) * 100)}%`,
                }}
                data-empty={bucket.wastedTokens === 0 ? "" : undefined}
              />
            </span>
            <span className={styles.barValue}>
              {formatTokens(bucket.wastedTokens)}
            </span>
            <span className={styles.barCount}>
              {t("cacheMissChartRatio", {
                misses: String(bucket.misses),
                total: String(bucket.misses + bucket.hits),
              })}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
