import type { PermissionMode } from "@yep-anywhere/shared";
import type { ProviderCommandOutput } from "../types.js";

type UnknownRecord = Record<string, unknown>;

export type CodexUsageView = "daily" | "weekly" | "cumulative";

export interface CodexCommandTokenSnapshot {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  contextWindow?: number;
}

export interface CodexStatusCommandInput {
  model: string;
  cwd: string;
  permissionMode: PermissionMode;
  threadId: string;
  tokenUsage?: CodexCommandTokenSnapshot;
  accountResponse?: unknown;
  rateLimitsResponse?: unknown;
}

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object"
    ? (value as UnknownRecord)
    : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function formatInteger(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function formatOptionalInteger(value: unknown): string {
  const number = finiteNumber(value);
  return number === null ? "-" : formatInteger(number);
}

function formatDuration(secondsValue: unknown): string {
  const seconds = finiteNumber(secondsValue);
  if (seconds === null) return "-";
  const wholeSeconds = Math.max(0, Math.round(seconds));
  const hours = Math.floor(wholeSeconds / 3600);
  const minutes = Math.floor((wholeSeconds % 3600) / 60);
  const remainder = wholeSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${remainder}s`;
  return `${remainder}s`;
}

export function parseCodexUsageView(
  argument: string | undefined,
): CodexUsageView | null {
  switch (argument?.trim().toLowerCase() ?? "") {
    case "":
    case "day":
    case "daily":
      return "daily";
    case "week":
    case "weekly":
      return "weekly";
    case "cumulative":
      return "cumulative";
    default:
      return null;
  }
}

export function isCodexChatGptAccount(response: unknown): boolean {
  const account = asRecord(asRecord(response)?.account);
  return account?.type === "chatgpt";
}

interface UsageBucket {
  date: string;
  tokens: number;
}

function usageBuckets(response: UnknownRecord): UsageBucket[] | null {
  if (!Array.isArray(response.dailyUsageBuckets)) return null;
  return response.dailyUsageBuckets
    .flatMap((value): UsageBucket[] => {
      const bucket = asRecord(value);
      const date = nonEmptyString(bucket?.startDate);
      const tokens = finiteNumber(bucket?.tokens);
      return date && tokens !== null ? [{ date, tokens }] : [];
    })
    .sort((left, right) => left.date.localeCompare(right.date));
}

function weekStart(dateText: string): string | null {
  const date = new Date(`${dateText}T00:00:00Z`);
  if (!Number.isFinite(date.getTime())) return null;
  const day = date.getUTCDay();
  date.setUTCDate(date.getUTCDate() - ((day + 6) % 7));
  return date.toISOString().slice(0, 10);
}

function weeklyBuckets(buckets: UsageBucket[]): UsageBucket[] {
  const totals = new Map<string, number>();
  for (const bucket of buckets) {
    const start = weekStart(bucket.date);
    if (!start) continue;
    totals.set(start, (totals.get(start) ?? 0) + bucket.tokens);
  }
  return [...totals].map(([date, tokens]) => ({ date, tokens }));
}

function usageHistoryLines(
  view: CodexUsageView,
  buckets: UsageBucket[] | null,
): string[] {
  if (buckets === null) return ["Token activity history unavailable"];
  if (buckets.length === 0) return ["No token activity recorded"];

  if (view === "daily") {
    return buckets
      .slice(-14)
      .map((bucket) => `${bucket.date}  ${formatInteger(bucket.tokens)}`);
  }

  const weeks = weeklyBuckets(buckets);
  if (view === "weekly") {
    return weeks
      .slice(-12)
      .map(
        (bucket) => `week of ${bucket.date}  ${formatInteger(bucket.tokens)}`,
      );
  }

  let cumulative = 0;
  return weeks
    .map((bucket) => {
      cumulative += bucket.tokens;
      return {
        date: bucket.date,
        tokens: cumulative,
      };
    })
    .slice(-12)
    .map(
      (bucket) =>
        `through week of ${bucket.date}  ${formatInteger(bucket.tokens)}`,
    );
}

export function formatCodexUsageCommand(
  responseValue: unknown,
  view: CodexUsageView,
): ProviderCommandOutput {
  const response = asRecord(responseValue);
  const summary = asRecord(response?.summary);
  if (!response || !summary) {
    return {
      summary: `/usage ${view}`,
      details: ["Token activity unavailable"],
    };
  }

  const streak = finiteNumber(summary.currentStreakDays);
  const longestStreak = finiteNumber(summary.longestStreakDays);
  const streakText =
    streak === null
      ? longestStreak === null
        ? "-"
        : `- (best ${formatInteger(longestStreak)}d)`
      : longestStreak === null || longestStreak === streak
        ? `${formatInteger(streak)}d`
        : `${formatInteger(streak)}d (best ${formatInteger(longestStreak)}d)`;

  const summaryLines = [
    "Token activity",
    `Lifetime: ${formatOptionalInteger(summary.lifetimeTokens)}`,
    `Peak day: ${formatOptionalInteger(summary.peakDailyTokens)}`,
    `Streak: ${streakText}`,
    `Longest task: ${formatDuration(summary.longestRunningTurnSec)}`,
  ];
  const history = usageHistoryLines(view, usageBuckets(response));
  return {
    summary: `/usage ${view}`,
    details: [
      summaryLines.join("\n"),
      `${view[0]?.toUpperCase()}${view.slice(1)}\n${history.join("\n")}`,
    ],
  };
}

function formatAccount(responseValue: unknown): string[] {
  if (responseValue === undefined) return ["Account: unavailable"];
  const account = asRecord(asRecord(responseValue)?.account);
  if (!account) return ["Account: signed out"];
  switch (account.type) {
    case "chatgpt": {
      const plan = nonEmptyString(account.planType);
      const email = nonEmptyString(account.email);
      return [
        `Account: ChatGPT${plan ? ` (${plan})` : ""}`,
        ...(email ? [`Email: ${email}`] : []),
      ];
    }
    case "apiKey":
      return ["Account: API key (API Platform billing)"];
    case "amazonBedrock":
      return ["Account: Amazon Bedrock"];
    default:
      return ["Account: unknown"];
  }
}

function formatWindowDuration(value: unknown): string {
  const minutes = finiteNumber(value);
  if (minutes === null || minutes <= 0) return "window";
  if (minutes % 10_080 === 0) return `${minutes / 10_080}w`;
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${Math.round(minutes)}m`;
}

function formatReset(value: unknown): string | null {
  const seconds = finiteNumber(value);
  if (seconds === null || seconds <= 0) return null;
  const date = new Date(seconds * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function formatRateLimitWindows(responseValue: unknown): string[] {
  if (responseValue === undefined) return ["Limits: unavailable"];
  const response = asRecord(responseValue);
  if (!response) return ["Limits: unavailable"];

  const snapshots = new Map<string, UnknownRecord>();
  const byLimitId = asRecord(response.rateLimitsByLimitId);
  if (byLimitId) {
    for (const [id, value] of Object.entries(byLimitId)) {
      const snapshot = asRecord(value);
      if (snapshot) snapshots.set(id, snapshot);
    }
  }
  const fallback = asRecord(response.rateLimits);
  if (fallback) {
    const id = nonEmptyString(fallback.limitId) ?? "codex";
    if (!snapshots.has(id)) snapshots.set(id, fallback);
  }

  const lines: string[] = [];
  for (const [id, snapshot] of snapshots) {
    const label = nonEmptyString(snapshot.limitName) ?? id;
    for (const [kind, value] of [
      ["primary", snapshot.primary],
      ["secondary", snapshot.secondary],
    ] as const) {
      const window = asRecord(value);
      const used = finiteNumber(window?.usedPercent);
      if (!window || used === null) continue;
      const reset = formatReset(window.resetsAt);
      const duration = formatWindowDuration(window.windowDurationMins);
      lines.push(
        `${label} ${kind} (${duration}): ${Math.round(used)}% used${reset ? `; resets ${reset}` : ""}`,
      );
    }
  }
  return lines.length > 0 ? lines : ["Limits: data not available yet"];
}

function formatTokenUsage(
  usage: CodexCommandTokenSnapshot | undefined,
): string[] {
  if (!usage) {
    return ["Token usage: 0 total", "Context window: not available yet"];
  }
  const inputOutput = `${formatInteger(usage.inputTokens)} input + ${formatInteger(usage.outputTokens)} output`;
  const lines = [
    `Token usage: ${formatInteger(usage.totalTokens)} total (${inputOutput})`,
  ];
  if (usage.cachedInputTokens > 0) {
    lines.push(`Cached input: ${formatInteger(usage.cachedInputTokens)}`);
  }
  if (usage.contextWindow && usage.contextWindow > 0) {
    const usedPercent = Math.min(
      100,
      Math.round((usage.totalTokens / usage.contextWindow) * 100),
    );
    lines.push(
      `Context window: ${100 - usedPercent}% left (${formatInteger(usage.totalTokens)} used / ${formatInteger(usage.contextWindow)})`,
    );
  } else {
    lines.push("Context window: not available yet");
  }
  return lines;
}

export function formatCodexStatusCommand(
  input: CodexStatusCommandInput,
): ProviderCommandOutput {
  return {
    summary: "/status",
    details: [
      [
        `Model: ${input.model}`,
        `Directory: ${input.cwd}`,
        `Permissions: ${input.permissionMode}`,
        `Session: ${input.threadId}`,
      ].join("\n"),
      formatAccount(input.accountResponse).join("\n"),
      formatTokenUsage(input.tokenUsage).join("\n"),
      formatRateLimitWindows(input.rateLimitsResponse).join("\n"),
    ],
  };
}
