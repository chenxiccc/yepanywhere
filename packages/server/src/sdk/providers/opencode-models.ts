import type { EffortLevel } from "@yep-anywhere/shared";

export interface OpenCodeModelSelection {
  providerID: string;
  modelID: string;
}

export const LOCAL_GLM_MODEL_PREFIX = "local-glm/";

export function getLocalGlmModelDescription(modelId: string): string {
  const servedModelName = modelId.slice(LOCAL_GLM_MODEL_PREFIX.length);
  const vllmModelArg =
    servedModelName === "Qwen/Qwen3.6-27B"
      ? "Qwen/Qwen3.6-27B-FP8"
      : servedModelName;
  const command = [
    "pixi run vllm serve",
    vllmModelArg,
    "--served-model-name",
    servedModelName,
    "--tool-call-parser qwen3_coder",
    "--reasoning-parser qwen3",
    "--enable-auto-tool-choice",
    "--port 8001",
  ].join(" ");

  return `Start matching vLLM server: ${command}`;
}

export function parseOpenCodeModelSelection(
  model: string | undefined,
): OpenCodeModelSelection | undefined {
  if (!model || model === "default" || model === "auto") {
    return undefined;
  }

  const slashIndex = model.indexOf("/");
  if (slashIndex <= 0 || slashIndex === model.length - 1) {
    throw new Error(
      `OpenCode model must use provider/model format, got "${model}"`,
    );
  }

  return {
    providerID: model.slice(0, slashIndex),
    modelID: model.slice(slashIndex + 1),
  };
}

const OPENCODE_EFFORT_LEVELS = new Set<EffortLevel>([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

/**
 * Parse `opencode models --verbose` output (header `provider/id` lines followed
 * by pretty-printed JSON model defs) into the advertised model keys in listing
 * order plus, per key, the reasoning effort levels that model's `variants`
 * expose. OpenCode passes effort by naming a variant in the message body; the
 * variant keys (low/medium/high/xhigh/max) coincide with YA's EffortLevel.
 *
 * The header lines are exactly what plain `opencode models` prints, so this one
 * invocation answers both the catalog and its effort metadata.
 */
export function parseOpenCodeVerboseModels(stdout: string): {
  ids: string[];
  variants: Map<string, EffortLevel[]>;
} {
  const variants = new Map<string, EffortLevel[]>();
  const ids: string[] = [];
  const seen = new Set<string>();
  let header: string | null = null;
  let block: string[] | null = null;
  for (const line of stdout.split("\n")) {
    if (block === null) {
      if (line === "{") {
        block = [line];
      } else if (line.trim() && line.includes("/") && !line.startsWith(" ")) {
        header = line.trim();
        if (!seen.has(header)) {
          seen.add(header);
          ids.push(header);
        }
      }
      continue;
    }
    block.push(line);
    if (line !== "}") continue;
    // Top-level closing brace (column 0) ends the model def block.
    try {
      const def = JSON.parse(block.join("\n")) as {
        id?: string;
        providerID?: string;
        variants?: Record<string, unknown>;
      };
      const key =
        header ??
        (def.providerID && def.id ? `${def.providerID}/${def.id}` : null);
      if (key && def.variants && typeof def.variants === "object") {
        const levels = Object.keys(def.variants).filter((v): v is EffortLevel =>
          OPENCODE_EFFORT_LEVELS.has(v as EffortLevel),
        );
        if (levels.length > 0) {
          variants.set(key, levels);
        }
      }
    } catch {
      // Skip unparseable block.
    }
    block = null;
    header = null;
  }
  return { ids, variants };
}

/** Effort-variant view of {@link parseOpenCodeVerboseModels}. */
export function parseOpenCodeModelVariants(
  stdout: string,
): Map<string, EffortLevel[]> {
  return parseOpenCodeVerboseModels(stdout).variants;
}
