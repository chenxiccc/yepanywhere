import { describe, expect, it, vi } from "vitest";
import { MergedSessionReader } from "../../src/sessions/merged-reader.js";
import type { ISessionReader } from "../../src/sessions/types.js";

function childReader(options: {
  accepted?: ReturnType<typeof vi.fn>;
}): ISessionReader {
  return {
    listProviderChildSessions: vi.fn(async () => []),
    ...(options.accepted
      ? { listAcceptedProviderChildSessions: options.accepted }
      : {}),
  } as unknown as ISessionReader;
}

describe("MergedSessionReader provider child freshness", () => {
  it("merges latest accepted projections without provider reads", () => {
    const first = vi.fn(() => [
      {
        id: "child-1",
        parentSessionId: "parent",
        updatedAt: "2026-08-05T00:00:00.000Z",
      },
    ]);
    const second = vi.fn(() => [
      {
        id: "child-2",
        parentSessionId: "parent",
        updatedAt: "2026-08-05T00:00:01.000Z",
      },
    ]);
    const reader = new MergedSessionReader([
      childReader({ accepted: first }),
      childReader({ accepted: second }),
    ]);

    expect(reader.listAcceptedProviderChildSessions("parent")).toEqual([
      expect.objectContaining({ id: "child-1" }),
      expect.objectContaining({ id: "child-2" }),
    ]);
    expect(first).toHaveBeenCalledWith("parent");
    expect(second).toHaveBeenCalledWith("parent");
  });

  it("declines the tier when any child reader cannot serve accepted state", () => {
    const reader = new MergedSessionReader([
      childReader({ accepted: vi.fn(() => []) }),
      childReader({}),
    ]);

    expect(reader.listAcceptedProviderChildSessions("parent")).toBeUndefined();
  });

  it("skips an unpublished cold root and keeps a published sibling", () => {
    const published = vi.fn(() => [
      {
        id: "child-1",
        parentSessionId: "parent",
        updatedAt: "2026-08-05T00:00:00.000Z",
      },
    ]);
    const reader = new MergedSessionReader([
      childReader({ accepted: vi.fn(() => undefined) }),
      childReader({ accepted: published }),
    ]);

    expect(reader.listAcceptedProviderChildSessions("parent")).toEqual([
      expect.objectContaining({ id: "child-1" }),
    ]);
    expect(published).toHaveBeenCalledWith("parent");
  });

  it("stays unpublished when every child-capable root is still cold", () => {
    const reader = new MergedSessionReader([
      childReader({ accepted: vi.fn(() => undefined) }),
      childReader({ accepted: vi.fn(() => undefined) }),
    ]);

    expect(reader.listAcceptedProviderChildSessions("parent")).toBeUndefined();
  });
});

describe("MergedSessionReader launch settings recovery", () => {
  it("uses the first authoritative root that contains recovery evidence", async () => {
    const missing = vi.fn(async () => null);
    const recovered = vi.fn(async () => ({
      permissionMode: "bypassPermissions" as const,
      requestedModel: "gpt-5.6-sol",
    }));
    const trailing = vi.fn(async () => ({
      permissionMode: "default" as const,
    }));
    const reader = new MergedSessionReader([
      { getRecoveredLaunchSettings: missing } as unknown as ISessionReader,
      { getRecoveredLaunchSettings: recovered } as unknown as ISessionReader,
      { getRecoveredLaunchSettings: trailing } as unknown as ISessionReader,
    ]);

    await expect(reader.getRecoveredLaunchSettings("session")).resolves.toEqual(
      {
        permissionMode: "bypassPermissions",
        requestedModel: "gpt-5.6-sol",
      },
    );
    expect(missing).toHaveBeenCalledWith("session");
    expect(recovered).toHaveBeenCalledWith("session");
    expect(trailing).not.toHaveBeenCalled();
  });
});
