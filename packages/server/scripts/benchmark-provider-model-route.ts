import { performance } from "node:perf_hooks";
import type { ProviderInfo } from "@yep-anywhere/shared";
import { createProvidersRoutes } from "../src/routes/providers.js";
import { getAllProviders } from "../src/sdk/providers/index.js";
import type { AgentProvider } from "../src/sdk/providers/types.js";

const DEFAULT_SAMPLES = 5;

interface ProbeCounts {
  auth: number;
  models: number;
}

interface Measurement {
  durationMs: number;
  models: number;
  probes: ProbeCounts;
}

function readSampleCount(): number {
  const configured = process.env.YA_PROVIDER_BENCHMARK_SAMPLES;
  if (!configured) return DEFAULT_SAMPLES;
  const parsed = Number.parseInt(configured, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(
      "YA_PROVIDER_BENCHMARK_SAMPLES must be a positive integer",
    );
  }
  return parsed;
}

function enabledProviderNames(): string[] | undefined {
  const configured = process.env.ENABLED_PROVIDERS;
  if (!configured) return undefined;
  const names = configured
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  return names.length > 0 ? names : undefined;
}

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(sorted.length * fraction) - 1);
  return sorted[index] ?? 0;
}

function instrumentProvider(
  provider: AgentProvider,
  counts: Map<string, ProbeCounts>,
): AgentProvider {
  return new Proxy(provider, {
    get(target, property) {
      if (property === "getAuthStatus") {
        return async () => {
          const providerCounts = counts.get(target.name) ?? {
            auth: 0,
            models: 0,
          };
          providerCounts.auth += 1;
          counts.set(target.name, providerCounts);
          return target.getAuthStatus();
        };
      }
      if (property === "getAvailableModels") {
        return async () => {
          const providerCounts = counts.get(target.name) ?? {
            auth: 0,
            models: 0,
          };
          providerCounts.models += 1;
          counts.set(target.name, providerCounts);
          return target.getAvailableModels();
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function sumProbes(counts: ReadonlyMap<string, ProbeCounts>): ProbeCounts {
  let auth = 0;
  let models = 0;
  for (const value of counts.values()) {
    auth += value.auth;
    models += value.models;
  }
  return { auth, models };
}

async function measure(path: string): Promise<Measurement> {
  const counts = new Map<string, ProbeCounts>();
  const providers = getAllProviders().map((provider) =>
    instrumentProvider(provider, counts),
  );
  const routes = createProvidersRoutes({
    providers,
    enabledProviders: enabledProviderNames(),
  });
  const startedAt = performance.now();
  const response = await routes.request(path);
  const durationMs = performance.now() - startedAt;
  if (!response.ok) {
    throw new Error(`${path} returned ${response.status}`);
  }
  const body = (await response.json()) as
    | { providers: ProviderInfo[] }
    | { provider: ProviderInfo };
  const rows = "providers" in body ? body.providers : [body.provider];
  return {
    durationMs,
    models: rows.reduce((total, row) => total + (row.models?.length ?? 0), 0),
    probes: sumProbes(counts),
  };
}

function report(
  label: string,
  samples: readonly Measurement[],
  extra: readonly string[] = [],
): void {
  const durations = samples.map((sample) => sample.durationMs);
  console.log(
    [
      label,
      `samples=${samples.length}`,
      `median_ms=${percentile(durations, 0.5).toFixed(2)}`,
      `p90_ms=${percentile(durations, 0.9).toFixed(2)}`,
      `models_last=${samples.at(-1)?.models ?? 0}`,
      `auth_probes_total=${samples.reduce((sum, sample) => sum + sample.probes.auth, 0)}`,
      `model_probes_total=${samples.reduce((sum, sample) => sum + sample.probes.models, 0)}`,
      ...extra,
    ].join(" "),
  );
}

const sampleCount = readSampleCount();
const providerNames = getAllProviders()
  .filter((provider) => {
    const enabled = enabledProviderNames();
    return !enabled || enabled.includes(provider.name);
  })
  .map((provider) => provider.name);

const aggregateSamples: Measurement[] = [];
for (let sample = 0; sample < sampleCount; sample += 1) {
  aggregateSamples.push(await measure("/?refresh=1"));
}
report("PROVIDER_MODEL_ROUTE:", aggregateSamples, [
  `providers=${providerNames.length}`,
]);

for (const providerName of providerNames) {
  const samples: Measurement[] = [];
  for (let sample = 0; sample < sampleCount; sample += 1) {
    samples.push(await measure(`/${providerName}?refresh=1`));
  }
  report("PROVIDER_MODEL_ROUTE_PROVIDER:", samples, [
    `provider=${providerName}`,
  ]);
}
