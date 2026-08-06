import type {
  ModelInfo,
  ProviderSubscriptionUsage,
  ProviderSubscriptionUsageScope,
  ProviderSubscriptionUsageWindow,
} from "@yep-anywhere/shared";

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object"
    ? (value as UnknownRecord)
    : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function usedPercent(value: unknown): number | null {
  const number = finiteNumber(value);
  return number === null ? null : Math.min(100, Math.max(0, number));
}

function positiveMinutes(value: unknown): number | undefined {
  const number = finiteNumber(value);
  return number !== null && number > 0 ? Math.round(number) : undefined;
}

function isoTimestamp(value: unknown): string | undefined {
  const text = nonEmptyString(value);
  if (!text) return undefined;
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp)
    ? new Date(timestamp).toISOString()
    : undefined;
}

function unixTimestamp(value: unknown): string | undefined {
  const seconds = finiteNumber(value);
  if (seconds === null || seconds <= 0) return undefined;
  const timestamp = seconds * 1000;
  return Number.isFinite(timestamp)
    ? new Date(timestamp).toISOString()
    : undefined;
}

function normalizedModelLabel(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function modelFamilyMatches(model: ModelInfo, family: string): boolean {
  const id = model.id.toLowerCase();
  const name = model.name.toLowerCase();
  const tokenPattern = new RegExp(`(?:^|[^a-z0-9])${family}(?:[^a-z0-9]|$)`);
  if (tokenPattern.test(id) || tokenPattern.test(name)) return true;
  if (model.id === "opusplan") {
    return family === "opus" || family === "sonnet";
  }
  return false;
}

function modelIdsForFamily(
  models: readonly ModelInfo[],
  family: string,
): string[] {
  return models
    .filter((model) => modelFamilyMatches(model, family))
    .map((model) => model.id);
}

function resolveModelBucket(
  label: string,
  models: readonly ModelInfo[],
): string[] {
  const normalizedLabel = normalizedModelLabel(label);
  const exact = models
    .filter(
      (model) =>
        normalizedModelLabel(model.id) === normalizedLabel ||
        normalizedModelLabel(model.name) === normalizedLabel,
    )
    .map((model) => model.id);
  if (exact.length > 0) return exact;

  const lowerLabel = label.toLowerCase();
  for (const family of ["fable", "opus", "sonnet", "haiku"]) {
    if (
      new RegExp(`(?:^|[^a-z0-9])${family}(?:[^a-z0-9]|$)`).test(lowerLabel)
    ) {
      return modelIdsForFamily(models, family);
    }
  }
  return [];
}

function addWindow(
  windows: ProviderSubscriptionUsageWindow[],
  window: ProviderSubscriptionUsageWindow | null,
): void {
  if (!window) return;
  windows.push(window);
}

function claudeWindow(
  id: string,
  value: unknown,
  durationMinutes: number,
  scope: ProviderSubscriptionUsageScope,
): ProviderSubscriptionUsageWindow | null {
  const record = asRecord(value);
  const percent = usedPercent(record?.utilization);
  if (!record || percent === null) return null;
  return {
    id,
    usedPercent: percent,
    windowDurationMinutes: durationMinutes,
    resetsAt: isoTimestamp(record.resets_at),
    scope,
  };
}

export function normalizeClaudeSubscriptionUsage(
  value: unknown,
  models: readonly ModelInfo[],
  fetchedAt = new Date(),
): ProviderSubscriptionUsage | null {
  const response = asRecord(value);
  if (response?.rate_limits_available !== true) return null;
  const limits = asRecord(response.rate_limits);
  if (!limits) return null;

  const windows: ProviderSubscriptionUsageWindow[] = [];
  addWindow(
    windows,
    claudeWindow("claude:five-hour", limits.five_hour, 300, {
      type: "provider",
    }),
  );
  addWindow(
    windows,
    claudeWindow("claude:seven-day", limits.seven_day, 10_080, {
      type: "provider",
    }),
  );
  addWindow(
    windows,
    claudeWindow(
      "claude:seven-day-oauth-apps",
      limits.seven_day_oauth_apps,
      10_080,
      { type: "provider", category: "oauthApps" },
    ),
  );

  for (const [key, family] of [
    ["seven_day_opus", "opus"],
    ["seven_day_sonnet", "sonnet"],
  ] as const) {
    const modelIds = modelIdsForFamily(models, family);
    if (modelIds.length === 0) continue;
    addWindow(
      windows,
      claudeWindow(`claude:${key.replaceAll("_", "-")}`, limits[key], 10_080, {
        type: "models",
        modelIds,
        label: family[0]?.toUpperCase() + family.slice(1),
      }),
    );
  }

  if (Array.isArray(limits.model_scoped)) {
    for (const [index, entry] of limits.model_scoped.entries()) {
      const record = asRecord(entry);
      const label = nonEmptyString(record?.display_name);
      if (!record || !label) continue;
      const modelIds = resolveModelBucket(label, models);
      if (modelIds.length === 0) continue;
      addWindow(
        windows,
        claudeWindow(
          `claude:model:${normalizedModelLabel(label) || index}`,
          record,
          10_080,
          { type: "models", modelIds, label },
        ),
      );
    }
  }

  return windows.length > 0
    ? {
        provider: "claude",
        windows,
        fetchedAt: fetchedAt.toISOString(),
      }
    : null;
}

function codexWindow(
  id: string,
  value: unknown,
  scope: ProviderSubscriptionUsageScope,
): ProviderSubscriptionUsageWindow | null {
  const record = asRecord(value);
  const percent = usedPercent(record?.usedPercent);
  if (!record || percent === null) return null;
  return {
    id,
    usedPercent: percent,
    windowDurationMinutes: positiveMinutes(record.windowDurationMins),
    resetsAt: unixTimestamp(record.resetsAt),
    scope,
  };
}

export function normalizeCodexSubscriptionUsage(
  value: unknown,
  models: readonly ModelInfo[],
  fetchedAt = new Date(),
): ProviderSubscriptionUsage | null {
  const response = asRecord(value);
  if (!response) return null;

  const snapshots = new Map<
    string,
    { snapshot: UnknownRecord; fallback: boolean }
  >();
  const byLimitId = asRecord(response.rateLimitsByLimitId);
  if (byLimitId) {
    for (const [key, rawSnapshot] of Object.entries(byLimitId)) {
      const snapshot = asRecord(rawSnapshot);
      if (snapshot) snapshots.set(key, { snapshot, fallback: false });
    }
  }

  const fallback = asRecord(response.rateLimits);
  if (fallback) {
    const fallbackId = nonEmptyString(fallback.limitId) ?? "codex";
    const alreadyPresent = [...snapshots.values()].some(
      ({ snapshot }) => (nonEmptyString(snapshot.limitId) ?? "") === fallbackId,
    );
    if (!alreadyPresent) {
      snapshots.set(fallbackId, { snapshot: fallback, fallback: true });
    }
  }

  const windows: ProviderSubscriptionUsageWindow[] = [];
  for (const [mapKey, { snapshot, fallback: isFallback }] of snapshots) {
    const limitId = nonEmptyString(snapshot.limitId) ?? mapKey;
    const label = nonEmptyString(snapshot.limitName);
    const providerWide =
      limitId.toLowerCase() === "codex" ||
      (isFallback && snapshots.size === 1 && !label);
    let scope: ProviderSubscriptionUsageScope;
    if (providerWide) {
      scope = { type: "provider" };
    } else {
      if (!label) continue;
      const modelIds = resolveModelBucket(label, models);
      if (modelIds.length === 0) continue;
      scope = { type: "models", modelIds, label };
    }

    addWindow(
      windows,
      codexWindow(`codex:${limitId}:primary`, snapshot.primary, scope),
    );
    addWindow(
      windows,
      codexWindow(`codex:${limitId}:secondary`, snapshot.secondary, scope),
    );
  }

  return windows.length > 0
    ? {
        provider: "codex",
        windows,
        fetchedAt: fetchedAt.toISOString(),
      }
    : null;
}
