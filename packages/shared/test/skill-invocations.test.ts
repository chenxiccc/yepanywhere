import { describe, expect, it } from "vitest";
import {
  canonicalizeSkillInvocations,
  findSkillInvocations,
  findUnrecognizedInvocations,
  getInvocationCompletionQuery,
  getLeadingSlashCommandName,
  type SlashCommand,
  startsWithSlashCommand,
} from "../src/index.js";

const commands: SlashCommand[] = [
  {
    name: "goal",
    description: "",
    invocation: { kind: "native", prefix: "/" },
  },
  {
    name: "doubt",
    description: "Check a conclusion independently",
    invocation: { kind: "skill", prefix: "$", aliases: ["verify"] },
  },
  {
    name: "review",
    description: "Review the current work",
    invocation: { kind: "skill", prefix: "$" },
  },
];

describe("skill invocation resolution", () => {
  it("canonicalizes every exact skill token without changing surrounding text", () => {
    expect(
      canonicalizeSkillInvocations(
        "compare /doubt with $review, then /verify",
        commands,
      ).text,
    ).toBe("compare $doubt with $review, then $doubt");
  });

  it("preserves the provider's canonical case in emitted tokens", () => {
    const mixedCase: SlashCommand[] = [
      {
        name: "BuildDocs",
        description: "Build the docs",
        invocation: { kind: "skill", prefix: "$" },
      },
    ];
    // Case-preserving so Codex's exact-name loader still recognizes it, while a
    // lowercased authored spelling is corrected up to the canonical name.
    expect(
      canonicalizeSkillInvocations("run $BuildDocs and $builddocs", mixedCase)
        .text,
    ).toBe("run $BuildDocs and $BuildDocs");
  });

  it("does not silently pick one skill on an ambiguous case collision", () => {
    const collision: SlashCommand[] = [
      {
        name: "Build",
        description: "Uppercase build skill",
        invocation: { kind: "skill", prefix: "$" },
      },
      {
        name: "build",
        description: "Lowercase build skill",
        invocation: { kind: "skill", prefix: "$" },
      },
    ];
    // Exact spellings each resolve to their own skill...
    expect(
      canonicalizeSkillInvocations("$Build then $build", collision).matches.map(
        (match) => match.command.description,
      ),
    ).toEqual(["Uppercase build skill", "Lowercase build skill"]);
    // ...but a spelling that matches neither exactly is left literal rather
    // than arbitrarily selecting one of the colliding skills.
    expect(canonicalizeSkillInvocations("$BUILD now", collision).text).toBe(
      "$BUILD now",
    );
    expect(findSkillInvocations("$BUILD now", collision)).toEqual([]);
  });

  it("leaves punctuation-adjacent and unknown spellings literal", () => {
    expect(
      canonicalizeSkillInvocations(
        "/missing keep /doubt, literal and /review exact",
        commands,
      ).text,
    ).toBe("/missing keep /doubt, literal and $review exact");
  });

  it("gives a leading provider-native slash command collision precedence", () => {
    const collision: SlashCommand[] = [
      ...commands,
      {
        name: "goal",
        description: "Goal skill",
        invocation: { kind: "skill", prefix: "$" },
      },
    ];
    expect(findSkillInvocations("/goal then /goal", collision)).toEqual([
      expect.objectContaining({
        start: 11,
        authoredToken: "/goal",
        canonicalToken: "$goal",
      }),
    ]);
  });

  it("offers completion only for a root invocation at the draft end", () => {
    expect(getInvocationCompletionQuery("/dou")).toEqual({
      start: 0,
      end: 4,
      sigil: "/",
      query: "dou",
      leading: true,
    });
    expect(getInvocationCompletionQuery("  /dou")).toEqual({
      start: 2,
      end: 6,
      sigil: "/",
      query: "dou",
      leading: true,
    });
    expect(getInvocationCompletionQuery("please /dou")).toBeNull();
    expect(getInvocationCompletionQuery("/dou later", 4)).toBeNull();
  });

  it("distinguishes unrecognized tokens from native and skill entries", () => {
    expect(
      findUnrecognizedInvocations("/goal then $missing and /doubt", commands),
    ).toEqual([
      expect.objectContaining({
        token: "$missing",
      }),
    ]);
  });

  it("does not rewrite from stale skill metadata", () => {
    const staleCommands: SlashCommand[] = [
      {
        name: "doubt",
        description: "Previously available",
        invocation: {
          kind: "skill",
          prefix: "$",
          inventoryState: "stale",
        },
      },
    ];
    expect(canonicalizeSkillInvocations("use /doubt", staleCommands).text).toBe(
      "use /doubt",
    );
    expect(findUnrecognizedInvocations("use /doubt", staleCommands)).toEqual(
      [],
    );
  });
});

describe("leading slash command detection", () => {
  it("reads the command name from an invocation at offset 0", () => {
    expect(getLeadingSlashCommandName("/goal ship the fix")).toBe("goal");
    expect(getLeadingSlashCommandName("/goal")).toBe("goal");
    expect(getLeadingSlashCommandName("/goal\nand then stop")).toBe("goal");
    expect(getLeadingSlashCommandName("/agent:code-review")).toBe(
      "agent:code-review",
    );
  });

  it("rejects tokens the provider would not parse as a command", () => {
    // A path, a mid-text token, and an indented command all reach the provider
    // as prose, so none of them may bypass correction framing.
    expect(startsWithSlashCommand("/local/graehl/yepanywhere")).toBe(false);
    expect(startsWithSlashCommand("run /goal after this")).toBe(false);
    expect(startsWithSlashCommand(" /goal ship the fix")).toBe(false);
    expect(startsWithSlashCommand("$doubt that conclusion")).toBe(false);
    expect(startsWithSlashCommand("//")).toBe(false);
    expect(startsWithSlashCommand("")).toBe(false);
  });
});
