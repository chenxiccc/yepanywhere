import type { UrlProjectId } from "@yep-anywhere/shared";
import { describe, expect, it, vi } from "vitest";
import { createTerminalRoutes } from "../../src/routes/terminal.js";
import { TerminalWorkspaceRegistry } from "../../src/terminal/TerminalWorkspaceRegistry.js";
import type { PtyFactory } from "../../src/terminal/TerminalWorkspaceTypes.js";

function createRegistry() {
  const createPty: PtyFactory = vi.fn(() => ({
    write() {},
    resize() {},
    kill() {},
    onData() {},
    onExit() {},
  }));

  return new TerminalWorkspaceRegistry({
    createPty,
    maxBufferBytes: 1024,
  });
}

describe("Terminal workspace routes", () => {
  it("creates, lists, renames, and deletes tabs", async () => {
    const registry = createRegistry();
    const routes = createTerminalRoutes({
      scanner: {
        getOrCreateProject: vi.fn(async () => ({
          id: "proj-1" as UrlProjectId,
          path: "/tmp/project",
          name: "project",
          sessionCount: 0,
          sessionDir: "/tmp/project/.claude",
          activeOwnedCount: 0,
          activeExternalCount: 0,
          lastActivity: null,
          provider: "claude",
        })),
      } as never,
      upgradeWebSocket: vi.fn() as never,
      registry,
    });

    const createResponse = await routes.request(
      "/projects/proj-1/terminal-tabs",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Build" }),
      },
    );
    expect(createResponse.status).toBe(200);
    const created = await createResponse.json();
    expect(created.tab.title).toBe("Build");

    const listResponse = await routes.request("/projects/proj-1/terminal-tabs");
    expect(listResponse.status).toBe(200);
    const listed = await listResponse.json();
    expect(listed.tabs).toHaveLength(1);

    const renameResponse = await routes.request(
      `/projects/proj-1/terminal-tabs/${created.tab.id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Shell" }),
      },
    );
    expect(renameResponse.status).toBe(200);
    const renamed = await renameResponse.json();
    expect(renamed.tab.title).toBe("Shell");

    const deleteResponse = await routes.request(
      `/projects/proj-1/terminal-tabs/${created.tab.id}`,
      {
        method: "DELETE",
      },
    );
    expect(deleteResponse.status).toBe(200);

    const listedAfterDelete = await (
      await routes.request("/projects/proj-1/terminal-tabs")
    ).json();
    expect(listedAfterDelete.tabs).toHaveLength(0);
  });

  it("returns 404 for unknown project", async () => {
    const routes = createTerminalRoutes({
      scanner: {
        getOrCreateProject: vi.fn(async () => null),
      } as never,
      upgradeWebSocket: vi.fn() as never,
      registry: createRegistry(),
    });

    const response = await routes.request("/projects/proj-1/terminal-tabs");
    expect(response.status).toBe(404);
  });
});
