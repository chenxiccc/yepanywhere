import {
  canonicalizeSkillInvocations,
  type SlashCommand,
} from "@yep-anywhere/shared";
import type { UserMessage } from "./types.js";

const SLASH_COMMAND_SUBMISSION_RE = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/;

export function normalizeSlashCommandName(name: string): string {
  return name.trim().replace(/^\/+/, "").toLowerCase();
}

export function isSlashCommandSubmission(text: string): boolean {
  return SLASH_COMMAND_SUBMISSION_RE.test(text);
}

/**
 * Split a `/command arg...` submission into its normalized command name and the
 * trailing argument text (empty string when none). Returns null when the text
 * is not a slash-command submission.
 */
export function parseSlashCommandSubmission(
  text: string,
): { name: string; argument: string } | null {
  const match = text.match(SLASH_COMMAND_SUBMISSION_RE);
  if (!match?.[1]) {
    return null;
  }
  return {
    name: normalizeSlashCommandName(match[1]),
    argument: match[2] ?? "",
  };
}

export function expandSlashCommandEmulation(
  message: UserMessage,
  commands: SlashCommand[] | null | undefined,
): UserMessage {
  const match = message.text.match(SLASH_COMMAND_SUBMISSION_RE);
  if (match?.[1]) {
    const commandName = normalizeSlashCommandName(match[1]);
    const command = commands?.find(
      (candidate) => normalizeSlashCommandName(candidate.name) === commandName,
    );
    const providerText = command?.emulation?.providerText?.trim();
    if (providerText) {
      return {
        ...message,
        text: providerText.replaceAll("{{argument}}", match[2] ?? "").trimEnd(),
      };
    }
  }

  const canonical = canonicalizeSkillInvocations(message.text, commands);
  return canonical.text === message.text
    ? message
    : { ...message, text: canonical.text };
}
