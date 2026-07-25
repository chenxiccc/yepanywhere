export const MAX_CLAUDE_ADDITIONAL_MODELS = 32;
export const MAX_CLAUDE_ADDITIONAL_MODEL_ID_LENGTH = 200;
export const MAX_CLAUDE_ADDITIONAL_MODEL_LABEL_LENGTH = 100;

export type ClaudeAdditionalModelOrigin = "registry" | "custom";

export interface ClaudeAdditionalModelSelection {
  id: string;
  label: string;
  origin: ClaudeAdditionalModelOrigin;
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code !== undefined && (code < 32 || code === 127)) return true;
  }
  return false;
}

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
      /\s/u.test(record.id) ||
      typeof record.label !== "string" ||
      record.label.length === 0 ||
      record.label.length > MAX_CLAUDE_ADDITIONAL_MODEL_LABEL_LENGTH ||
      record.label.trim() !== record.label ||
      containsControlCharacter(record.label) ||
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
