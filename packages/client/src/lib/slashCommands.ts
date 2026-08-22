import {
  getCanonicalInvocationToken,
  type SlashCommand,
  type ThinkingOption,
} from "@yep-anywhere/shared";

export const CLIENT_SLASH_COMMANDS = [
  "fast",
  "run",
  "btw",
  "done",
  "archive",
  "terminate",
  "title",
  "model",
] as const;

export type ComposerSlashCommand =
  | { kind: "fast"; argument: string }
  | { kind: "run"; argument: string }
  | { kind: "custom"; command: string; argument: string };

export type ComposerSlashTurn =
  | {
      kind: "message";
      text: string;
      command?: "fast" | "run";
      thinking?: ThinkingOption;
    }
  | { kind: "custom"; command: string; argument: string }
  | { kind: "error"; command: "fast" | "run"; message: string };

export type ComposerDoneTarget =
  | "focused-aside"
  | "synthetic-session"
  | "provider";

export type ComposerSessionOperation =
  | { kind: "provider" }
  | { kind: "focused-aside"; command: "done"; argument: string }
  | {
      kind: "session-boundary";
      command: "done" | "archive" | "terminate";
    }
  | { kind: "title"; title: string | null }
  | {
      kind: "blocked";
      command: "archive" | "terminate" | "title";
      message: string;
    };

export function resolveComposerSessionOperation({
  text,
  routesToFocusedAside,
  syntheticDoneEnabled,
  syntheticDoneSupported,
  syntheticArchiveSupported,
  syntheticTerminateSupported,
  hasAttachments,
}: {
  text: string;
  routesToFocusedAside: boolean;
  syntheticDoneEnabled: boolean;
  syntheticDoneSupported: boolean;
  syntheticArchiveSupported: boolean;
  syntheticTerminateSupported: boolean;
  hasAttachments: boolean;
}): ComposerSessionOperation {
  const parsed = parseComposerSlashCommand(text);
  if (parsed?.kind !== "custom") {
    return { kind: "provider" };
  }

  if (parsed.command === "done") {
    if (routesToFocusedAside) {
      return {
        kind: "focused-aside",
        command: "done",
        argument: parsed.argument,
      };
    }
    if (syntheticDoneEnabled && !parsed.argument.trim() && !hasAttachments) {
      return { kind: "session-boundary", command: "done" };
    }
    return { kind: "provider" };
  }

  if (parsed.command === "archive") {
    if (routesToFocusedAside) {
      return {
        kind: "blocked",
        command: "archive",
        message:
          "/archive is unavailable while the composer targets a /btw aside.",
      };
    }
    if (parsed.argument.trim() || hasAttachments) {
      return {
        kind: "blocked",
        command: "archive",
        message: "Use /archive by itself without attachments.",
      };
    }
    if (syntheticArchiveSupported) {
      return { kind: "session-boundary", command: "archive" };
    }
    if (syntheticDoneSupported) {
      return { kind: "session-boundary", command: "done" };
    }
    return { kind: "provider" };
  }

  if (parsed.command === "terminate") {
    if (routesToFocusedAside) {
      return {
        kind: "blocked",
        command: "terminate",
        message:
          "/terminate is unavailable while the composer targets a /btw aside.",
      };
    }
    if (parsed.argument.trim() || hasAttachments) {
      return {
        kind: "blocked",
        command: "terminate",
        message: "Use /terminate by itself without attachments.",
      };
    }
    return syntheticDoneEnabled && syntheticTerminateSupported
      ? { kind: "session-boundary", command: "terminate" }
      : { kind: "provider" };
  }

  if (parsed.command === "title") {
    if (routesToFocusedAside) {
      return {
        kind: "blocked",
        command: "title",
        message:
          "/title is unavailable while the composer targets a /btw aside.",
      };
    }
    if (hasAttachments) {
      return {
        kind: "blocked",
        command: "title",
        message: "Remove attachments before using /title.",
      };
    }
    return { kind: "title", title: parsed.argument.trim() || null };
  }

  return { kind: "provider" };
}

export function resolveComposerDoneTarget({
  text,
  routesToFocusedAside,
  syntheticDoneEnabled,
  hasAttachments,
}: {
  text: string;
  routesToFocusedAside: boolean;
  syntheticDoneEnabled: boolean;
  hasAttachments: boolean;
}): ComposerDoneTarget {
  const operation = resolveComposerSessionOperation({
    text,
    routesToFocusedAside,
    syntheticDoneEnabled,
    syntheticDoneSupported: syntheticDoneEnabled,
    syntheticArchiveSupported: false,
    syntheticTerminateSupported: false,
    hasAttachments,
  });
  if (operation.kind === "focused-aside") {
    return "focused-aside";
  }
  if (operation.kind === "session-boundary") {
    return "synthetic-session";
  }
  return "provider";
}

const COMMAND_DISPLAY: Record<string, { label: string; shortcut: string }> = {
  fast: { label: "fast turn", shortcut: "/f" },
  run: { label: "run exactly", shortcut: "/r" },
  btw: { label: "btw aside", shortcut: "/b" },
  done: { label: "done with aside", shortcut: "/d" },
  archive: { label: "archive session", shortcut: "/archive" },
  terminate: { label: "terminate session", shortcut: "/terminate" },
  title: { label: "title session", shortcut: "/title" },
  model: { label: "model", shortcut: "/m" },
};

export function createClientSlashCommand(name: string): SlashCommand {
  const normalized = normalizeSlashCommandForMatch(name);
  return {
    name: normalized,
    description: normalized === "run" ? "Direct local shell: !!cmd" : "",
    invocation: { kind: "emulated", prefix: "/" },
  };
}

export function getSlashCommandMenuParts(command: string | SlashCommand): {
  shortcut: string;
  rest: string;
  label: string;
} {
  const normalized =
    typeof command === "string"
      ? normalizeSlashCommandForMatch(command)
      : normalizeSlashCommandForMatch(command.name);
  const canonical =
    typeof command === "string"
      ? command.startsWith("/") || command.startsWith("$")
        ? command
        : `/${normalized}`
      : getCanonicalInvocationToken(command);
  const display = COMMAND_DISPLAY[normalized];
  if (!display) {
    return {
      shortcut: "",
      rest: canonical,
      label: canonical,
    };
  }

  const label = `/${display.label}`;
  return {
    shortcut: display.shortcut,
    rest: label.slice(display.shortcut.length),
    label,
  };
}

export function getLeadingSlashQuery(text: string): string | null {
  const match = text.match(/^\/([^\s/]*)$/);
  return match ? (match[1] ?? "").toLowerCase() : null;
}

export function normalizeSlashCommandForMatch(command: string): string {
  return command.replace(/^[/\\$]+/, "").toLowerCase();
}

export function parseComposerSlashCommand(
  text: string,
): ComposerSlashCommand | null {
  const match = text.match(/^\/([^\s/]+)(?:\s+([\s\S]*))?$/);
  if (!match) {
    return null;
  }

  const command = match[1]?.toLowerCase() ?? "";
  const argument = match[2] ?? "";

  if (command === "f" || command === "fast") {
    return { kind: "fast", argument };
  }
  if (command === "r" || command === "run") {
    return { kind: "run", argument };
  }
  if (command === "m" || command === "model") {
    return { kind: "custom", command: "model", argument };
  }
  if (command === "b" || command === "btw") {
    return { kind: "custom", command: "btw", argument };
  }
  if (command === "d" || command === "done") {
    return { kind: "custom", command: "done", argument };
  }
  if (command === "archive") {
    return { kind: "custom", command: "archive", argument };
  }
  if (command === "terminate") {
    return { kind: "custom", command: "terminate", argument };
  }
  if (command === "title") {
    return { kind: "custom", command: "title", argument };
  }
  if (command === "compact") {
    return { kind: "custom", command, argument };
  }

  return null;
}

export function buildRunExactlyPrompt(command: string): string {
  const indentedCommand = command.replace(/^/gm, "    ");
  return [
    "Run exactly this shell command. Treat the indented block as literal shell text; do not rewrite, shorten, or add arguments.",
    "Use the shell execution tool directly. If it may run for more than a moment, run it in a PTY/session and return after the initial output.",
    "Do not keep polling, summarize, or analyze the full output unless I ask.",
    "",
    indentedCommand,
  ].join("\n");
}

export function resolveComposerSlashTurn(text: string): ComposerSlashTurn {
  const parsed = parseComposerSlashCommand(text);
  if (!parsed) {
    return { kind: "message", text };
  }

  if (parsed.kind === "custom") {
    return parsed;
  }

  const argument = parsed.argument.trim();
  if (!argument) {
    const command = parsed.kind;
    return {
      kind: "error",
      command,
      message:
        command === "fast"
          ? "Add a request after /fast or /f."
          : "Add a shell command after /run or /r.",
    };
  }

  if (parsed.kind === "fast") {
    return {
      kind: "message",
      text: argument,
      command: "fast",
      thinking: "off",
    };
  }

  return {
    kind: "message",
    text: buildRunExactlyPrompt(argument),
    command: "run",
    thinking: "off",
  };
}
