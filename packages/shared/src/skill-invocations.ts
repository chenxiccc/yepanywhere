import type { SlashCommand } from "./types.js";

const INVOCATION_NAME_SOURCE = "[A-Za-z0-9][A-Za-z0-9._:-]*";
const INVOCATION_TOKEN_RE = new RegExp(
  `(^|\\s)([/\\$])(${INVOCATION_NAME_SOURCE})(?=\\s|$)`,
  "g",
);
const INVOCATION_NAME_RE = new RegExp(`^${INVOCATION_NAME_SOURCE}$`);

export interface SkillInvocationMatch {
  command: SlashCommand;
  start: number;
  end: number;
  authoredToken: string;
  canonicalToken: string;
}

export interface InvocationCandidate {
  start: number;
  end: number;
  sigil: "/" | "$";
  name: string;
  token: string;
}

export interface InvocationCompletionQuery {
  start: number;
  end: number;
  sigil: "/" | "$";
  query: string;
  leading: boolean;
}

export function normalizeInvocationName(name: string): string {
  return name.trim().replace(/^[/\\$]+/, "").toLowerCase();
}

export function hasInvocationCandidate(text: string): boolean {
  return /(^|\s)[/$][A-Za-z0-9]/.test(text);
}

export function getCanonicalInvocationToken(command: SlashCommand): string {
  return `${command.invocation?.prefix ?? "/"}${normalizeInvocationName(command.name)}`;
}

export function getInvocationNames(command: SlashCommand): string[] {
  return [
    normalizeInvocationName(command.name),
    ...(command.invocation?.aliases ?? []).map(normalizeInvocationName),
  ].filter((name, index, names) => !!name && names.indexOf(name) === index);
}

function findSkillCommand(
  commands: readonly SlashCommand[],
  normalizedName: string,
): SlashCommand | undefined {
  return commands.find(
    (command) =>
      command.invocation?.kind === "skill" &&
      command.invocation.inventoryState !== "stale" &&
      getInvocationNames(command).includes(normalizedName),
  );
}

function leadingSlashIsNative(
  commands: readonly SlashCommand[],
  normalizedName: string,
): boolean {
  return commands.some(
    (command) =>
      getInvocationNames(command).includes(normalizedName) &&
      command.invocation?.kind !== "skill",
  );
}

export function findInvocationCandidates(text: string): InvocationCandidate[] {
  const candidates: InvocationCandidate[] = [];
  INVOCATION_TOKEN_RE.lastIndex = 0;
  for (const match of text.matchAll(INVOCATION_TOKEN_RE)) {
    const whitespace = match[1] ?? "";
    const sigil = match[2];
    const name = match[3];
    if ((sigil !== "/" && sigil !== "$") || !name) continue;
    const start = (match.index ?? 0) + whitespace.length;
    const token = `${sigil}${name}`;
    candidates.push({
      start,
      end: start + token.length,
      sigil,
      name,
      token,
    });
  }
  return candidates;
}

export function findSkillInvocations(
  text: string,
  commands: readonly SlashCommand[] | null | undefined,
): SkillInvocationMatch[] {
  if (!commands?.length) return [];

  const matches: SkillInvocationMatch[] = [];
  for (const candidate of findInvocationCandidates(text)) {
    const normalizedName = normalizeInvocationName(candidate.name);
    if (
      candidate.start === 0 &&
      candidate.sigil === "/" &&
      leadingSlashIsNative(commands, normalizedName)
    ) {
      continue;
    }

    const command = findSkillCommand(commands, normalizedName);
    if (!command) continue;
    matches.push({
      command,
      start: candidate.start,
      end: candidate.end,
      authoredToken: candidate.token,
      canonicalToken: getCanonicalInvocationToken(command),
    });
  }
  return matches;
}

export function findUnrecognizedInvocations(
  text: string,
  commands: readonly SlashCommand[],
): InvocationCandidate[] {
  return findInvocationCandidates(text).filter((candidate) => {
    const normalizedName = normalizeInvocationName(candidate.name);
    if (
      commands.some(
        (command) =>
          command.invocation?.kind === "skill" &&
          getInvocationNames(command).includes(normalizedName),
      )
    ) {
      return false;
    }
    return !(
      candidate.start === 0 &&
      candidate.sigil === "/" &&
      commands.some((command) =>
        getInvocationNames(command).includes(normalizedName),
      )
    );
  });
}

export function canonicalizeSkillInvocations(
  text: string,
  commands: readonly SlashCommand[] | null | undefined,
): { text: string; matches: SkillInvocationMatch[] } {
  const matches = findSkillInvocations(text, commands);
  let canonicalText = text;
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const match = matches[index];
    if (!match || match.authoredToken === match.canonicalToken) continue;
    canonicalText =
      canonicalText.slice(0, match.start) +
      match.canonicalToken +
      canonicalText.slice(match.end);
  }
  return { text: canonicalText, matches };
}

export function getInvocationCompletionQuery(
  text: string,
  cursor = text.length,
): InvocationCompletionQuery | null {
  const boundedCursor = Math.max(0, Math.min(cursor, text.length));
  let start = boundedCursor;
  while (start > 0 && !/\s/.test(text[start - 1] ?? "")) start -= 1;

  const sigil = text[start];
  if (sigil !== "/" && sigil !== "$") return null;

  let end = boundedCursor;
  while (end < text.length && !/\s/.test(text[end] ?? "")) end += 1;
  const wholeToken = text.slice(start + 1, end);
  const query = text.slice(start + 1, boundedCursor);
  if (
    (wholeToken && !INVOCATION_NAME_RE.test(wholeToken)) ||
    (query && !INVOCATION_NAME_RE.test(query))
  ) {
    return null;
  }

  return {
    start,
    end,
    sigil,
    query: query.toLowerCase(),
    leading: start === 0,
  };
}

export function commandMatchesInvocationQuery(
  command: SlashCommand,
  query: InvocationCompletionQuery,
): boolean {
  if (
    (query.sigil === "$" || !query.leading) &&
    command.invocation?.kind !== "skill"
  ) {
    return false;
  }
  return getInvocationNames(command).some((name) => name.startsWith(query.query));
}
