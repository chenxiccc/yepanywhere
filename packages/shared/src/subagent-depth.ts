export const MIN_SUBAGENT_MAX_DEPTH = 0;
export const MAX_SUBAGENT_MAX_DEPTH = 4;
export const DEFAULT_SUBAGENT_MAX_DEPTH = 1;

/** Null leaves nesting depth to provider and operator configuration. */
export type SubagentMaxDepth = number | null;

export function isSubagentMaxDepth(value: unknown): value is SubagentMaxDepth {
  return (
    value === null ||
    (typeof value === "number" &&
      Number.isInteger(value) &&
      value >= MIN_SUBAGENT_MAX_DEPTH &&
      value <= MAX_SUBAGENT_MAX_DEPTH)
  );
}
