import type { CodexSessionEntry, ToolResultMedia } from "@yep-anywhere/shared";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthService } from "../../src/auth/AuthService.js";
import { SESSION_COOKIE_NAME } from "../../src/auth/routes.js";
import { ToolResultMediaStore } from "../../src/media/ToolResultMediaStore.js";
import { createAuthMiddleware } from "../../src/middleware/auth.js";
import { createToolResultMediaRoutes } from "../../src/routes/tool-result-media.js";
import { normalizeSession } from "../../src/sessions/normalization.js";
import type { LoadedSession } from "../../src/sessions/types.js";
import type { SDKMessage } from "../../src/sdk/types.js";
import { Process } from "../../src/supervisor/Process.js";
import { encodeProjectId } from "../../src/supervisor/types.js";
import type { ProjectScanner } from "../../src/projects/scanner.js";

const execFileAsync = promisify(execFile);
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const PNG_BYTES = Buffer.from(PNG_BASE64, "base64");
const DATA_URL = `data:image/png;base64,${PNG_BASE64}`;

describe("tool-result media storage", () => {
  let tempDir: string;
  let projectDir: string;
  let dataDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "yep-tool-result-media-"));
    projectDir = join(tempDir, "project");
    dataDir = join(tempDir, "data");
    await mkdir(projectDir, { recursive: true });
    await execFileAsync("git", ["init", "-q", projectDir]);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("stores authoritative returned bytes and git-excludes a new .yep", async () => {
    const sourcePath = join(projectDir, "source.png");
    const differentSourceBytes = Buffer.from(PNG_BYTES);
    differentSourceBytes[differentSourceBytes.length - 1] ^= 0xff;
    await writeFile(sourcePath, differentSourceBytes);

    const store = new ToolResultMediaStore({ dataDir });
    const projectId = encodeProjectId(projectDir);
    const media = await store.capture(
      { dataUrl: DATA_URL, originalPath: sourcePath },
      {
        provider: "codex",
        projectId,
        projectPath: projectDir,
        getSessionId: () => "session-a",
      },
      "call-a",
      0,
    );

    expect(media).toMatchObject({
      state: "stored",
      mimeType: "image/png",
      width: 1,
      height: 1,
    });
    if (media.state !== "stored") throw new Error("Expected stored media");

    await writeFile(sourcePath, "source mutated after capture");
    const file = await store.getMediaFile(
      projectDir,
      projectId,
      "session-a",
      media.id,
    );
    expect(file?.path).toContain(
      join(".yep", "tool-results", "session-a", "blobs"),
    );
    await expect(readFile(file?.path ?? "")).resolves.toEqual(PNG_BYTES);
    await expect(
      readFile(join(projectDir, ".git", "info", "exclude"), "utf8"),
    ).resolves.toContain(".yep/");
  });

  it("rejects a same-size blob whose bytes no longer match its content hash", async () => {
    const store = new ToolResultMediaStore({ dataDir });
    const projectId = encodeProjectId(projectDir);
    const media = await captureDataUrl(store, projectDir, "session-corrupt");
    if (media.state !== "stored") throw new Error("Expected stored media");
    const file = await store.getMediaFile(
      projectDir,
      projectId,
      "session-corrupt",
      media.id,
    );
    if (!file) throw new Error("Expected stored media file");

    const corruptBytes = Buffer.alloc(file.byteLength, 0x5a);
    await writeFile(file.path, corruptBytes);

    await expect(
      store.getMediaFile(
        projectDir,
        projectId,
        "session-corrupt",
        media.id,
      ),
    ).resolves.toBeNull();
  });

  it("repairs a same-size corrupted blob when the content is captured again", async () => {
    const store = new ToolResultMediaStore({ dataDir });
    const projectId = encodeProjectId(projectDir);
    const first = await captureDataUrl(store, projectDir, "session-repair");
    if (first.state !== "stored") throw new Error("Expected stored media");
    const file = await store.getMediaFile(
      projectDir,
      projectId,
      "session-repair",
      first.id,
    );
    if (!file) throw new Error("Expected stored media file");
    await writeFile(file.path, Buffer.alloc(file.byteLength, 0x5a));

    const repaired = await captureDataUrl(
      store,
      projectDir,
      "session-repair",
    );

    expect(repaired).toMatchObject({ state: "stored", id: first.id });
    await expect(readFile(file.path)).resolves.toEqual(PNG_BYTES);
  });

  it("does not rewrite git excludes when .yep already exists", async () => {
    await mkdir(join(projectDir, ".yep"), { recursive: true });
    const excludePath = join(projectDir, ".git", "info", "exclude");
    await writeFile(excludePath, "# user-owned exclude\n");

    const media = await captureDataUrl(
      new ToolResultMediaStore({ dataDir }),
      projectDir,
      "session-existing",
    );

    expect(media.state).toBe("stored");
    await expect(readFile(excludePath, "utf8")).resolves.toBe(
      "# user-owned exclude\n",
    );
  });

  it("snapshots a permitted path-only image at capture time", async () => {
    const sourcePath = join(projectDir, "path-only.png");
    await writeFile(sourcePath, PNG_BYTES);
    const store = new ToolResultMediaStore({ dataDir });
    const projectId = encodeProjectId(projectDir);
    const media = await store.capture(
      { originalPath: sourcePath },
      {
        provider: "codex",
        projectId,
        projectPath: projectDir,
        getSessionId: () => "session-path-only",
      },
      "call-path-only",
      0,
    );
    if (media.state !== "stored") throw new Error("Expected stored media");

    await rm(sourcePath);
    const file = await store.getMediaFile(
      projectDir,
      projectId,
      "session-path-only",
      media.id,
    );
    await expect(readFile(file?.path ?? "")).resolves.toEqual(PNG_BYTES);
  });

  it.skipIf(process.platform === "win32")(
    "falls back to the server data directory for a symlinked .yep",
    async () => {
      const outside = join(tempDir, "outside");
      await mkdir(outside);
      await symlink(outside, join(projectDir, ".yep"));
      const store = new ToolResultMediaStore({ dataDir });
      const media = await captureDataUrl(store, projectDir, "session-fallback");

      expect(media.state).toBe("stored");
      if (media.state !== "stored") throw new Error("Expected stored media");
      const file = await store.getMediaFile(
        projectDir,
        encodeProjectId(projectDir),
        "session-fallback",
        media.id,
      );
      expect(await realpath(file?.path ?? "")).toContain(
        await realpath(join(dataDir, "tool-results")),
      );
    },
  );

  it("rejects unsupported SVG bytes without creating a fetchable handle", async () => {
    const store = new ToolResultMediaStore({ dataDir });
    const media = await store.capture(
      {
        dataUrl: `data:image/svg+xml;base64,${Buffer.from("<svg/>").toString("base64")}`,
      },
      {
        provider: "claude",
        projectId: encodeProjectId(projectDir),
        projectPath: projectDir,
        getSessionId: () => "session-svg",
      },
      "call-svg",
      0,
    );

    expect(media).toEqual({
      state: "rejected",
      toolCallId: "call-svg",
      reason: "unsupported-media",
    });
  });

  it("materializes normalized Codex output without retaining inline data", async () => {
    const entries: CodexSessionEntry[] = [
      {
        type: "response_item",
        timestamp: "2026-07-27T00:00:00Z",
        payload: {
          type: "function_call",
          name: "view_image",
          call_id: "call-codex",
          arguments: JSON.stringify({ path: "source.png" }),
        },
      },
      {
        type: "response_item",
        timestamp: "2026-07-27T00:00:01Z",
        payload: {
          type: "function_call_output",
          call_id: "call-codex",
          output: DATA_URL,
        },
      },
    ];
    const projectId = encodeProjectId(projectDir);
    const normalized = normalizeSession(
      buildCodexLoadedSession(entries, projectId),
    );
    const materialized = await new ToolResultMediaStore({
      dataDir,
    })
      .createMaterializer({
        provider: "codex",
        projectId,
        projectPath: projectDir,
        getSessionId: () => "session-codex",
      })
      .materializeMessages(normalized.messages);

    expect(JSON.stringify(materialized)).not.toContain("data:image");
    expect(materialized[1]?.toolResultMedia).toEqual([
      expect.objectContaining({
        state: "stored",
        mimeType: "image/png",
      }),
    ]);
  });

  it("preserves Claude Read image behavior through the shared materializer", async () => {
    const store = new ToolResultMediaStore({ dataDir });
    const projectId = encodeProjectId(projectDir);
    const messages = [
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "call-read",
              name: "Read",
              input: { file_path: "source.png" },
            },
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "call-read",
              content: "Image read",
            },
          ],
        },
        toolUseResult: {
          type: "image",
          file: {
            base64: PNG_BASE64,
            type: "image/png",
            dimensions: { originalWidth: 1, originalHeight: 1 },
          },
        },
      },
    ];

    const materialized = await store
      .createMaterializer({
        provider: "claude",
        projectId,
        projectPath: projectDir,
        getSessionId: () => "session-read",
      })
      .materializeMessages(messages);

    expect(JSON.stringify(materialized)).not.toContain(PNG_BASE64);
    expect(materialized[1]?.toolResultMedia).toEqual([
      expect.objectContaining({ state: "stored", width: 1, height: 1 }),
    ]);
  });

  it("partitions grouped provider-neutral image blocks by tool call", async () => {
    const materialized = await new ToolResultMediaStore({ dataDir })
      .createMaterializer({
        provider: "opencode",
        projectId: encodeProjectId(projectDir),
        projectPath: projectDir,
        getSessionId: () => "session-neutral",
      })
      .materializeMessages([
        {
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: "call-text",
                name: "ReadMetadata",
                input: {},
              },
              {
                type: "tool_use",
                id: "call-neutral",
                name: "RenderDiagram",
                input: {},
              },
            ],
          },
        },
        {
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "call-text",
                content: "No image here",
              },
              {
                type: "tool_result",
                tool_use_id: "call-neutral",
                content: [
                  {
                    type: "image",
                    source: {
                      type: "base64",
                      media_type: "image/png",
                      data: PNG_BASE64,
                    },
                  },
                ],
              },
            ],
          },
        },
      ]);

    expect(JSON.stringify(materialized)).not.toContain(PNG_BASE64);
    expect(materialized[1]?.toolResultMedia).toEqual([
      expect.objectContaining({
        state: "stored",
        toolCallId: "call-neutral",
        mimeType: "image/png",
      }),
    ]);
  });

  it("materializes live Process messages before replay retains them", async () => {
    async function* messages(): AsyncGenerator<SDKMessage> {
      yield {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "call-live",
              name: "RenderDiagram",
              input: {},
            },
          ],
        },
      };
      yield {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "call-live",
              content: DATA_URL,
            },
          ],
        },
      };
    }

    const process = new Process(messages(), {
      projectId: encodeProjectId(projectDir),
      projectPath: projectDir,
      provider: "opencode",
      sessionId: "session-live",
      idleTimeoutMs: 20,
      toolResultMediaStore: new ToolResultMediaStore({ dataDir }),
    });

    await vi.waitFor(() => {
      expect(process.getMessageHistory().length).toBeGreaterThanOrEqual(2);
    });
    const history = process.getMessageHistory();
    expect(JSON.stringify(history)).not.toContain("data:image");
    expect(history[1]?.toolResultMedia).toEqual([
      expect.objectContaining({ state: "stored", mimeType: "image/png" }),
    ]);
    await process.abort();
  });

  it("serves only handles bound to the requested project and session", async () => {
    const store = new ToolResultMediaStore({ dataDir });
    const projectId = encodeProjectId(projectDir);
    const media = await captureDataUrl(store, projectDir, "session-route");
    if (media.state !== "stored") throw new Error("Expected stored media");

    const routes = createToolResultMediaRoutes({
      store,
      scanner: {
        getProject: async (requestedId: string) =>
          requestedId === projectId ? { path: projectDir } : null,
      } as ProjectScanner,
    });
    const response = await routes.request(
      `/projects/${projectId}/sessions/session-route/media/${media.id}`,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(PNG_BYTES);

    const wrongSession = await routes.request(
      `/projects/${projectId}/sessions/other-session/media/${media.id}`,
    );
    expect(wrongSession.status).toBe(404);
    expect(
      await routes.request(
        `/projects/${encodeProjectId(join(tempDir, "other"))}/sessions/session-route/media/${media.id}`,
      ),
    ).toMatchObject({ status: 404 });
  });

  it("keeps the handle behind normal auth and outside public-share routes", async () => {
    const store = new ToolResultMediaStore({ dataDir });
    const projectId = encodeProjectId(projectDir);
    const media = await captureDataUrl(store, projectDir, "session-auth");
    if (media.state !== "stored") throw new Error("Expected stored media");
    const mediaRoutes = createToolResultMediaRoutes({
      store,
      scanner: {
        getProject: async (requestedId: string) =>
          requestedId === projectId ? { path: projectDir } : null,
      } as ProjectScanner,
    });
    const authService = {
      hasAccount: () => true,
      isEnabled: () => true,
      validateSession: async (sessionId: string) => sessionId === "authorized",
    } as AuthService;
    const app = new Hono();
    app.use("/api/*", createAuthMiddleware({ authService }));
    app.route("/api", mediaRoutes);
    const path = `/api/projects/${projectId}/sessions/session-auth/media/${media.id}`;

    expect((await app.request(path, undefined, {})).status).toBe(401);
    expect(
      (
        await app.request(
          path,
          {
            headers: { Cookie: `${SESSION_COOKIE_NAME}=authorized` },
          },
          {},
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await app.request(
          `/public-api/shares/not-a-share/sessions/session-auth/media/${media.id}`,
          undefined,
          {},
        )
      ).status,
    ).toBe(404);
  });
});

async function captureDataUrl(
  store: ToolResultMediaStore,
  projectDir: string,
  sessionId: string,
): Promise<ToolResultMedia> {
  return store.capture(
    { dataUrl: DATA_URL, claimedMimeType: "image/png" },
    {
      provider: "codex",
      projectId: encodeProjectId(projectDir),
      projectPath: projectDir,
      getSessionId: () => sessionId,
    },
    "call-image",
    0,
  );
}

function buildCodexLoadedSession(
  entries: CodexSessionEntry[],
  projectId: ReturnType<typeof encodeProjectId>,
): LoadedSession {
  return {
    summary: {
      id: "session-codex",
      projectId,
      title: "Image session",
      fullTitle: "Image session",
      createdAt: "2026-07-27T00:00:00Z",
      updatedAt: "2026-07-27T00:00:01Z",
      messageCount: entries.length,
      status: "chat",
      provider: "codex",
    },
    data: {
      provider: "codex",
      events: [],
      session: { entries },
    },
  } as unknown as LoadedSession;
}
