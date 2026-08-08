export interface ClaudeSteerBackgroundBashSettings {
  allowRegex: string;
  denyRegex: string;
}

export const DEFAULT_CLAUDE_STEER_BACKGROUND_BASH: ClaudeSteerBackgroundBashSettings =
  {
    allowRegex: ".*",
    denyRegex: "",
  };

export const MAX_CLAUDE_STEER_BACKGROUND_BASH_REGEX_LENGTH = 2_000;

function compileWholeCommandRegex(source: string): RegExp {
  // Validate the operator source on its own. Compiling only after interpolation
  // can accidentally balance malformed source with syntax from our wrapper.
  new RegExp(source, "s");
  // A bare `$` also matches before one final line terminator in JavaScript.
  // The negative lookahead requires the true end of the command string.
  return new RegExp(`^(?:${source})(?![\\s\\S])`, "s");
}

export function parseClaudeSteerBackgroundBashSettings(
  value: unknown,
): ClaudeSteerBackgroundBashSettings | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some(
      (key) => key !== "allowRegex" && key !== "denyRegex",
    ) ||
    typeof record.allowRegex !== "string" ||
    typeof record.denyRegex !== "string" ||
    record.allowRegex.length > MAX_CLAUDE_STEER_BACKGROUND_BASH_REGEX_LENGTH ||
    record.denyRegex.length > MAX_CLAUDE_STEER_BACKGROUND_BASH_REGEX_LENGTH
  ) {
    return null;
  }

  try {
    if (record.allowRegex !== "") {
      compileWholeCommandRegex(record.allowRegex);
    }
    if (record.denyRegex !== "") {
      compileWholeCommandRegex(record.denyRegex);
    }
  } catch {
    return null;
  }

  return {
    allowRegex: record.allowRegex,
    denyRegex: record.denyRegex,
  };
}

export function createClaudeSteerBackgroundBashMatcher(
  settings: ClaudeSteerBackgroundBashSettings,
): (command: string) => boolean {
  const parsed = parseClaudeSteerBackgroundBashSettings(settings);
  if (!parsed) {
    return () => false;
  }
  if (parsed.allowRegex === "") {
    return () => false;
  }

  const allow = compileWholeCommandRegex(parsed.allowRegex);
  const deny =
    parsed.denyRegex === "" ? null : compileWholeCommandRegex(parsed.denyRegex);
  return (command) => allow.test(command) && !(deny?.test(command) ?? false);
}
