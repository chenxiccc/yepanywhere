import type { CacheMissBillingRecord } from "@yep-anywhere/shared";
import { useI18n } from "../../i18n";
import styles from "./CacheMissInactivityChart.module.css";

/**
 * Minute buckets for the inactivity axis. Cache lifetimes are discussed in
 * minutes and the interesting structure is at the short end — a miss two
 * minutes after the last turn means something quite different from one at two
 * hours — so the buckets are fine early and coarse later.
 */
const BUCKET_EDGES_MINUTES = [10, 20, 30, 60] as const;

export interface InactivityBucket {
  /** Inclusive lower edge in minutes. */
  fromMinutes: number;
  /** Exclusive upper edge in minutes; undefined for the final open bucket. */
  toMinutes?: number;
  misses: number;
  hits: number;
  wastedTokens: number;
  events: CacheMissBillingRecord[];
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
      events: [],
    });
    previousEdge = edge;
  }
  buckets.push({
    fromMinutes: previousEdge,
    misses: 0,
    hits: 0,
    wastedTokens: 0,
    events: [],
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
    bucket.events.push(event);
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
  return `${bucket.fromMinutes}–${bucket.toMinutes}m`;
}

function populatedBuckets(buckets: InactivityBucket[]): InactivityBucket[] {
  let lastPopulatedIndex = -1;
  for (let index = buckets.length - 1; index >= 0; index -= 1) {
    if (buckets[index]?.events.length) {
      lastPopulatedIndex = index;
      break;
    }
  }
  return lastPopulatedIndex < 0 ? [] : buckets.slice(0, lastPopulatedIndex + 1);
}

function providerModelTuple(
  event: CacheMissBillingRecord,
  unknownModel: string,
): string {
  return `${event.provider} / ${event.model?.trim() || unknownModel}`;
}

function tupleTooltip(
  events: CacheMissBillingRecord[],
  unknownModel: string,
  heading: string,
  empty: string,
): string {
  const tuples = [
    ...new Set(events.map((event) => providerModelTuple(event, unknownModel))),
  ].sort();
  return tuples.length > 0 ? `${heading}\n${tuples.join("\n")}` : empty;
}

function missRate(bucket: Pick<InactivityBucket, "misses" | "hits">): number {
  const total = bucket.misses + bucket.hits;
  return total === 0 ? 0 : bucket.misses / total;
}

function formatMissRate(rate: number): string {
  const percentage = rate * 100;
  if (percentage === 0) return "0%";
  if (percentage < 0.1) return `${percentage.toFixed(2)}%`;
  if (percentage < 10) return `${percentage.toFixed(1)}%`;
  return `${Math.round(percentage)}%`;
}

/** Logarithmic display keeps sub-percent empirical rates visible. */
export function logarithmicRateWidth(rate: number): number {
  if (rate <= 0) return 0;
  return (Math.log10(1 + Math.min(1, rate) * 999) / 3) * 100;
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
  const tooltip = (bucketEvents: CacheMissBillingRecord[]) =>
    tupleTooltip(
      bucketEvents,
      t("cacheMissUnknownModel"),
      t("cacheMissTupleTooltipHeading"),
      t("cacheMissTupleTooltipEmpty"),
    );
  const buckets = populatedBuckets(bucketByInactivity(events));
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
          <li
            className={styles.bar}
            key={bucket.fromMinutes}
            title={tooltip(bucket.events)}
          >
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

/** Empirical miss probability from records whose sampler retained every hit. */
export function CacheMissProbabilityChart({
  events,
}: {
  events: CacheMissBillingRecord[];
}) {
  const { t } = useI18n();
  const tooltip = (bucketEvents: CacheMissBillingRecord[]) =>
    tupleTooltip(
      bucketEvents,
      t("cacheMissUnknownModel"),
      t("cacheMissTupleTooltipHeading"),
      t("cacheMissTupleTooltipEmpty"),
    );
  const completeEvents = events.filter(
    (event) => event.completeProbabilitySample === true,
  );
  const buckets = populatedBuckets(bucketByInactivity(completeEvents));
  if (buckets.length === 0) {
    return <p className="settings-empty">{t("cacheMissProbabilityEmpty")}</p>;
  }

  return (
    <div className={styles.chart}>
      <p className="settings-hint">{t("cacheMissProbabilitySampleNote")}</p>
      <ol className={styles.bars}>
        {buckets.map((bucket) => {
          const rate = missRate(bucket);
          return (
            <li
              className={styles.bar}
              key={bucket.fromMinutes}
              title={tooltip(bucket.events)}
            >
              <span className={styles.barLabel}>{bucketLabel(bucket)}</span>
              <span className={styles.barTrack}>
                <span
                  className={`${styles.barFill} ${styles.probabilityFill}`}
                  style={{ width: `${logarithmicRateWidth(rate)}%` }}
                  data-empty={rate === 0 ? "" : undefined}
                />
              </span>
              <span className={styles.barValue}>{formatMissRate(rate)}</span>
              <span className={styles.barCount}>
                {t("cacheMissChartRatio", {
                  misses: String(bucket.misses),
                  total: String(bucket.misses + bucket.hits),
                })}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

interface ProviderBucket {
  provider: string;
  misses: number;
  hits: number;
  events: CacheMissBillingRecord[];
}

function bucketByProvider(events: CacheMissBillingRecord[]): ProviderBucket[] {
  const buckets = new Map<string, ProviderBucket>();
  for (const event of events) {
    if (event.completeProbabilitySample !== true) continue;
    const bucket = buckets.get(event.provider) ?? {
      provider: event.provider,
      misses: 0,
      hits: 0,
      events: [],
    };
    bucket.events.push(event);
    if (event.outcome === "unexpected-recompute") bucket.misses += 1;
    else bucket.hits += 1;
    buckets.set(event.provider, bucket);
  }
  return [...buckets.values()].sort((a, b) =>
    a.provider.localeCompare(b.provider),
  );
}

export function CacheMissProviderChart({
  events,
}: {
  events: CacheMissBillingRecord[];
}) {
  const { t } = useI18n();
  const tooltip = (bucketEvents: CacheMissBillingRecord[]) =>
    tupleTooltip(
      bucketEvents,
      t("cacheMissUnknownModel"),
      t("cacheMissTupleTooltipHeading"),
      t("cacheMissTupleTooltipEmpty"),
    );
  const buckets = bucketByProvider(events);
  if (buckets.length === 0) {
    return <p className="settings-empty">{t("cacheMissProviderEmpty")}</p>;
  }

  return (
    <div className={styles.chart}>
      <p className="settings-hint">{t("cacheMissProbabilitySampleNote")}</p>
      <ol className={styles.bars}>
        {buckets.map((bucket) => {
          const rate = missRate(bucket);
          return (
            <li
              className={styles.bar}
              key={bucket.provider}
              title={tooltip(bucket.events)}
            >
              <span className={styles.barLabel}>{bucket.provider}</span>
              <span className={styles.barTrack}>
                <span
                  className={`${styles.barFill} ${styles.providerFill}`}
                  style={{ width: `${logarithmicRateWidth(rate)}%` }}
                  data-empty={rate === 0 ? "" : undefined}
                />
              </span>
              <span className={styles.barValue}>{formatMissRate(rate)}</span>
              <span className={styles.barCount}>
                {t("cacheMissChartRatio", {
                  misses: String(bucket.misses),
                  total: String(bucket.misses + bucket.hits),
                })}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
