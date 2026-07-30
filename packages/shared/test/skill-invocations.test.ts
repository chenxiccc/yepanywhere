import { describe, expect, it } from "vitest";
import {
  canonicalizeSkillInvocations,
  findSkillInvocations,
  findUnrecognizedInvocations,
  getInvocationCompletionQuery,
  type SlashCommand,
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

  it("finds a completion token at the caret inside ordinary prompt text", () => {
    expect(getInvocationCompletionQuery("please /dou later", 11)).toEqual({
      start: 7,
      end: 11,
      sigil: "/",
      query: "dou",
      leading: false,
    });
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
