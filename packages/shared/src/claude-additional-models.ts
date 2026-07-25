export const MAX_CLAUDE_ADDITIONAL_MODELS = 32;
export const MAX_CLAUDE_ADDITIONAL_MODEL_ID_LENGTH = 200;
export const MAX_CLAUDE_ADDITIONAL_MODEL_LABEL_LENGTH = 100;

export type ClaudeAdditionalModelOrigin = "registry" | "custom";

export interface ClaudeAdditionalModelSelection {
  id: string;
  label: string;
  origin: ClaudeAdditionalModelOrigin;
}

const CONTROL_OR_WHITESPACE = /[\s\u0000-\u001f\u007f]/u;
const CONTROL = /[\u0000-\u001f\u007f]/u;

/**
 * Parse the persisted/wire representation without consulting the current
 * registry. Registry-removed selections must remain valid and loadable.
 */
export function parseClaudeAdditionalModelSelections(
  value: unknown,
): ClaudeAdditionalModelSelection[] | null {
  if (!Array.isArray(value) || value.length > MAX_CLAUDE_ADDITIONAL_MODELS) {
    return null;
  }

  const seen = new Set<string>();
  const selections: ClaudeAdditionalModelSelection[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return null;
    }
    const record = entry as Record<string, unknown>;
    if (
      typeof record.id !== "string" ||
      record.id.length === 0 ||
      record.id.length > MAX_CLAUDE_ADDITIONAL_MODEL_ID_LENGTH ||
      CONTROL_OR_WHITESPACE.test(record.id) ||
      typeof record.label !== "string" ||
      record.label.length === 0 ||
      record.label.length > MAX_CLAUDE_ADDITIONAL_MODEL_LABEL_LENGTH ||
      record.label.trim() !== record.label ||
      CONTROL.test(record.label) ||
      (record.origin !== "registry" && record.origin !== "custom") ||
      seen.has(record.id)
    ) {
      return null;
    }
    seen.add(record.id);
    selections.push({
      id: record.id,
      label: record.label,
      origin: record.origin,
    });
  }

  return selections;
}
