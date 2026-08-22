import { describe, expect, it } from "vitest";
import {
  buildRunExactlyPrompt,
  getLeadingSlashQuery,
  getSlashCommandMenuParts,
  normalizeSlashCommandForMatch,
  parseComposerSlashCommand,
  resolveComposerDoneTarget,
  resolveComposerSessionOperation,
  resolveComposerSlashTurn,
} from "../slashCommands";

describe("slashCommands", () => {
  it("parses fast and run aliases only when they start with slash", () => {
    expect(parseComposerSlashCommand("/f check status")).toEqual({
      kind: "fast",
      argument: "check status",
    });
    expect(parseComposerSlashCommand("/fast check status")).toEqual({
      kind: "fast",
      argument: "check status",
    });
    expect(parseComposerSlashCommand("/r git diff")).toEqual({
      kind: "run",
      argument: "git diff",
    });
    expect(parseComposerSlashCommand("/run git diff")).toEqual({
      kind: "run",
      argument: "git diff",
    });
    expect(parseComposerSlashCommand("f check status")).toBeNull();
    expect(parseComposerSlashCommand("!git diff")).toBeNull();
  });

  it("parses highlighted model shortcut as the model command", () => {
    expect(parseComposerSlashCommand("/m")).toEqual({
      kind: "custom",
      command: "model",
      argument: "",
    });
    expect(parseComposerSlashCommand("/model")).toEqual({
      kind: "custom",
      command: "model",
      argument: "",
    });
  });

  it("parses /done and /d as a client-side close-aside command", () => {
    expect(parseComposerSlashCommand("/d")).toEqual({
      kind: "custom",
      command: "done",
      argument: "",
    });
    expect(parseComposerSlashCommand("/done")).toEqual({
      kind: "custom",
      command: "done",
      argument: "",
    });
    expect(parseComposerSlashCommand("/done with notes")).toEqual({
      kind: "custom",
      command: "done",
      argument: "with notes",
    });
    expect(resolveComposerSlashTurn("/done")).toEqual({
      kind: "custom",
      command: "done",
      argument: "",
    });
  });

  it("resolves local archive and title operations without provider ingress", () => {
    const resolve = (
      text: string,
      overrides: Partial<
        Parameters<typeof resolveComposerSessionOperation>[0]
      > = {},
    ) =>
      resolveComposerSessionOperation({
        text,
        routesToFocusedAside: false,
        syntheticDoneEnabled: true,
        syntheticDoneSupported: true,
        syntheticArchiveSupported: true,
        syntheticTerminateSupported: true,
        hasAttachments: false,
        ...overrides,
      });

    expect(parseComposerSlashCommand("/archive")).toEqual({
      kind: "custom",
      command: "archive",
      argument: "",
    });
    expect(parseComposerSlashCommand("/title A concise title")).toEqual({
      kind: "custom",
      command: "title",
      argument: "A concise title",
    });
    expect(resolve("/archive")).toEqual({
      kind: "session-boundary",
      command: "archive",
    });
    expect(resolve("/archive", { syntheticArchiveSupported: false })).toEqual({
      kind: "session-boundary",
      command: "done",
    });
    expect(
      resolve("/archive", {
        syntheticArchiveSupported: false,
        syntheticDoneSupported: false,
      }),
    ).toEqual({ kind: "provider" });
    expect(resolve("/archive later")).toMatchObject({
      kind: "blocked",
      command: "archive",
    });
    expect(parseComposerSlashCommand("/terminate")).toEqual({
      kind: "custom",
      command: "terminate",
      argument: "",
    });
    expect(resolve("/terminate")).toEqual({
      kind: "session-boundary",
      command: "terminate",
    });
    expect(
      resolve("/terminate", { syntheticTerminateSupported: false }),
    ).toEqual({ kind: "provider" });
    expect(resolve("/terminate", { syntheticDoneEnabled: false })).toEqual({
      kind: "provider",
    });
    expect(resolve("/terminate later")).toMatchObject({
      kind: "blocked",
      command: "terminate",
    });
    expect(resolve("/title A concise title")).toEqual({
      kind: "title",
      title: "A concise title",
    });
    expect(resolve("/title")).toEqual({ kind: "title", title: null });
  });

  it("keeps Mother-session operations out of focused asides", () => {
    const resolve = (text: string) =>
      resolveComposerSessionOperation({
        text,
        routesToFocusedAside: true,
        syntheticDoneEnabled: true,
        syntheticDoneSupported: true,
        syntheticArchiveSupported: true,
        syntheticTerminateSupported: true,
        hasAttachments: false,
      });

    expect(resolve("/archive")).toMatchObject({
      kind: "blocked",
      command: "archive",
    });
    expect(resolve("/terminate")).toMatchObject({
      kind: "blocked",
      command: "terminate",
    });
    expect(resolve("/title New title")).toMatchObject({
      kind: "blocked",
      command: "title",
    });
    expect(resolve("/done report back")).toEqual({
      kind: "focused-aside",
      command: "done",
      argument: "report back",
    });
  });

  it("routes /done by composer destination, opt-in, and attachments", () => {
    expect(
      resolveComposerDoneTarget({
        text: "/done",
        routesToFocusedAside: true,
        syntheticDoneEnabled: true,
        hasAttachments: false,
      }),
    ).toBe("focused-aside");
    expect(
      resolveComposerDoneTarget({
        text: "/done",
        routesToFocusedAside: false,
        syntheticDoneEnabled: true,
        hasAttachments: false,
      }),
    ).toBe("synthetic-session");
    expect(
      resolveComposerDoneTarget({
        text: "/done",
        routesToFocusedAside: false,
        syntheticDoneEnabled: false,
        hasAttachments: false,
      }),
    ).toBe("provider");
    expect(
      resolveComposerDoneTarget({
        text: "/done with notes",
        routesToFocusedAside: false,
        syntheticDoneEnabled: true,
        hasAttachments: false,
      }),
    ).toBe("provider");
    expect(
      resolveComposerDoneTarget({
        text: "/done",
        routesToFocusedAside: false,
        syntheticDoneEnabled: true,
        hasAttachments: true,
      }),
    ).toBe("provider");
  });

  it("parses /btw as a client-side aside command", () => {
    expect(parseComposerSlashCommand("/b side lookup")).toEqual({
      kind: "custom",
      command: "btw",
      argument: "side lookup",
    });
    expect(parseComposerSlashCommand("/btw side lookup")).toEqual({
      kind: "custom",
      command: "btw",
      argument: "side lookup",
    });
    expect(resolveComposerSlashTurn("/btw side lookup")).toEqual({
      kind: "custom",
      command: "btw",
      argument: "side lookup",
    });
  });

  it("renders whole command labels with shortcut parts split out", () => {
    expect(getSlashCommandMenuParts("fast")).toEqual({
      shortcut: "/f",
      rest: "ast turn",
      label: "/fast turn",
    });
    expect(getSlashCommandMenuParts("run")).toEqual({
      shortcut: "/r",
      rest: "un exactly",
      label: "/run exactly",
    });
    expect(getSlashCommandMenuParts("goal")).toEqual({
      shortcut: "",
      rest: "/goal",
      label: "/goal",
    });
    expect(getSlashCommandMenuParts("btw")).toEqual({
      shortcut: "/b",
      rest: "tw aside",
      label: "/btw aside",
    });
    expect(getSlashCommandMenuParts("archive")).toEqual({
      shortcut: "/archive",
      rest: " session",
      label: "/archive session",
    });
    expect(getSlashCommandMenuParts("terminate")).toEqual({
      shortcut: "/terminate",
      rest: " session",
      label: "/terminate session",
    });
    expect(getSlashCommandMenuParts("title")).toEqual({
      shortcut: "/title",
      rest: " session",
      label: "/title session",
    });
    expect(getSlashCommandMenuParts("model")).toEqual({
      shortcut: "/m",
      rest: "odel",
      label: "/model",
    });
    expect(getSlashCommandMenuParts("compact")).toEqual({
      shortcut: "",
      rest: "/compact",
      label: "/compact",
    });
  });

  it("matches leading slash command drafts for composer suggestions", () => {
    expect(getLeadingSlashQuery("/")).toBe("");
    expect(getLeadingSlashQuery("/Fo")).toBe("fo");
    expect(getLeadingSlashQuery("/foo bar")).toBeNull();
    expect(getLeadingSlashQuery(" /foo")).toBeNull();
    expect(normalizeSlashCommandForMatch("///Fast")).toBe("fast");
  });

  it("turns /fast into a thinking-off message", () => {
    expect(resolveComposerSlashTurn("/f summarize this")).toEqual({
      kind: "message",
      text: "summarize this",
      command: "fast",
      thinking: "off",
    });
  });

  it("turns /run into a thinking-off exact-run instruction", () => {
    const resolved = resolveComposerSlashTurn("/r git diff -- README.md");

    expect(resolved.kind).toBe("message");
    if (resolved.kind !== "message") {
      throw new Error("Expected a message turn");
    }
    expect(resolved.command).toBe("run");
    expect(resolved.thinking).toBe("off");
    expect(resolved.text).toContain("Run exactly this shell command");
    expect(resolved.text).toContain("    git diff -- README.md");
  });

  it("returns errors for slash commands that need an argument", () => {
    expect(resolveComposerSlashTurn("/f")).toEqual({
      kind: "error",
      command: "fast",
      message: "Add a request after /fast or /f.",
    });
    expect(resolveComposerSlashTurn("/run")).toEqual({
      kind: "error",
      command: "run",
      message: "Add a shell command after /run or /r.",
    });
  });

  it("keeps unknown provider slash commands as normal messages", () => {
    expect(resolveComposerSlashTurn("/permissions")).toEqual({
      kind: "message",
      text: "/permissions",
    });
    expect(resolveComposerSlashTurn("/goal all tests pass")).toEqual({
      kind: "message",
      text: "/goal all tests pass",
    });
  });

  it("indents every command line in exact-run prompts", () => {
    expect(buildRunExactlyPrompt("printf one\nprintf two")).toContain(
      "    printf one\n    printf two",
    );
  });
});
