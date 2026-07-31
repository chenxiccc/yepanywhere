import type { ClaudeAdditionalModelSelection } from "@yep-anywhere/shared";
import { describe, expect, it } from "vitest";
import {
  getClaudeAdditionalModelOptions,
  getClaudeModelCatalogCacheKey,
  projectClaudeAdditionalModels,
} from "../../../src/sdk/providers/claude-additional-models.js";

describe("Claude additional model catalog", () => {
  it("offers the maintained registry without enabling it", () => {
    expect(getClaudeAdditionalModelOptions()).toEqual([
      expect.objectContaining({
        id: "claude-opus-4-6",
        name: "Opus 4.6",
        catalogGroup: "additional",
      }),
      expect.objectContaining({
        id: "claude-sonnet-4-6",
        name: "Sonnet 4.6",
        catalogGroup: "additional",
      }),
    ]);
  });

  it("leaves the primary catalog membership unchanged with no opt-ins", () => {
    const primary = [{ id: "opus", name: "Opus" }];

    expect(projectClaudeAdditionalModels(primary, [])).toEqual(primary);
  });

  it("projects selected registry and custom entries in saved order", () => {
    const selections: ClaudeAdditionalModelSelection[] = [
      {
        id: "claude-opus-4-6",
        label: "Saved label is superseded",
        origin: "registry",
      },
      {
        id: "claude-experimental-6",
        label: "Experimental 6",
        origin: "custom",
      },
    ];

    expect(
      projectClaudeAdditionalModels(
        [{ id: "opus", name: "Opus" }],
        selections,
      ),
    ).toEqual([
      { id: "opus", name: "Opus" },
      expect.objectContaining({
        id: "claude-opus-4-6",
        name: "Opus 4.6",
        catalogGroup: "additional",
      }),
      {
        id: "claude-experimental-6",
        name: "Experimental 6",
        description: "Custom model ID",
        catalogGroup: "additional",
      },
    ]);
  });

  it("grandfathers a removed registry selection as unlisted", () => {
    const selections: ClaudeAdditionalModelSelection[] = [
      {
        id: "claude-opus-4-5",
        label: "Opus 4.5",
        origin: "registry",
      },
    ];

    expect(projectClaudeAdditionalModels([], selections)).toEqual([
      {
        id: "claude-opus-4-5",
        name: "Opus 4.5",
        description:
          "Previously enabled model · no longer maintained by this server",
        catalogGroup: "additional",
      },
    ]);
  });

  it("does not duplicate a primary model", () => {
    const primary = [{ id: "claude-opus-4-6", name: "SDK Opus 4.6" }];

    expect(
      projectClaudeAdditionalModels(primary, [
        {
          id: "claude-opus-4-6",
          label: "Opus 4.6",
          origin: "registry",
        },
      ]),
    ).toEqual(primary);
  });

  it("changes the route cache key when settings change", () => {
    expect(
      getClaudeModelCatalogCacheKey([
        { id: "one", label: "One", origin: "custom" },
      ]),
    ).not.toBe(
      getClaudeModelCatalogCacheKey([
        { id: "two", label: "Two", origin: "custom" },
      ]),
    );
  });
});
