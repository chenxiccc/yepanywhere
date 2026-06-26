// 纯函数测试：extractSessionIdFromPath 从路由 pathname 末段提取 session id
// Pure function tests for extractSessionIdFromPath.

import { describe, expect, it } from "vitest";
import { extractSessionIdFromPath } from "../useNotifyInApp";

describe("extractSessionIdFromPath", () => {
  it("extracts the session id from a direct-mode session route", () => {
    // projectId 是 base64url（不含 /），sessionId 是 hex，末段即 session id
    const path =
      "/projects/L1VzZXJzL2FkbWluL0RvY3VtZW50cy9wcm9qZWN0L3llcGFueXdoZXJl/sessions/3428fa66-3892-4cfd-aa0b-c2504cba8277";
    expect(extractSessionIdFromPath(path)).toBe(
      "3428fa66-3892-4cfd-aa0b-c2504cba8277",
    );
  });

  it("extracts the session id from a relay-mode route with a username prefix", () => {
    // relay 模式挂在 /:relayUsername 下，前缀不影响末段提取
    const path =
      "/myuser/projects/L1VzZXJzL2FkbWluL0RvY3VtZW50cy9wcm9qZWN0L3llcGFueXdoZXJl/sessions/abc123";
    expect(extractSessionIdFromPath(path)).toBe("abc123");
  });

  it("handles a trailing slash", () => {
    const path =
      "/projects/abc/sessions/3428fa66-3892-4cfd-aa0b-c2504cba8277/";
    expect(extractSessionIdFromPath(path)).toBe(
      "3428fa66-3892-4cfd-aa0b-c2504cba8277",
    );
  });

  it("returns null on the global sessions list route", () => {
    // /sessions 列表页，无末段 session id
    expect(extractSessionIdFromPath("/sessions")).toBeNull();
    expect(extractSessionIdFromPath("/sessions/")).toBeNull();
  });

  it("returns null on non-session routes", () => {
    expect(extractSessionIdFromPath("/projects")).toBeNull();
    expect(extractSessionIdFromPath("/new-session")).toBeNull();
    expect(extractSessionIdFromPath("/")).toBeNull();
    expect(extractSessionIdFromPath("/agents")).toBeNull();
  });

  it("returns null for a session sub-route (does not match mid-path)", () => {
    // $ 锚定末段：/sessions/<id>/sub 不应匹配（按"不在看"处理，多推不漏推）
    const path = "/projects/abc/sessions/3428fa66/sub";
    expect(extractSessionIdFromPath(path)).toBeNull();
  });

  it("returns null for an empty or malformed path", () => {
    expect(extractSessionIdFromPath("")).toBeNull();
    expect(extractSessionIdFromPath("/sessions//")).toBeNull();
  });
});
