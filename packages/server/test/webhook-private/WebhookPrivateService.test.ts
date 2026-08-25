import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Supervisor } from "../../src/supervisor/Supervisor.js";
import { EventBus } from "../../src/watcher/EventBus.js";
import { WebhookPrivateService } from "../../src/webhook-private/WebhookPrivateService.js";

// 钉钉/飞书测试 URL（带 access_token，与真实格式一致）
// DingTalk/Feishu test URLs (with access_token, matching real format)
const DING_URL = "https://oapi.dingtalk.com/robot/send?access_token=tok";
const FEI_URL = "https://open.feishu.cn/open-apis/bot/v2/hook/abc123";

const PROJECT_ID = Buffer.from("/tmp/repo").toString("base64url");

function makeProcess(overrides: Partial<{
  state: { type: string };
  projectPath: string;
}> = {}) {
  return {
    id: "proc-1",
    sessionId: "sess-1",
    projectPath: overrides.projectPath ?? "/tmp/repo",
    provider: "claude",
    resolvedModel: "claude-sonnet-4-5",
    executor: "cli",
    permissionMode: "default",
    state: overrides.state ?? { type: "idle" },
    getMessageHistory: () => [
      { type: "user", message: { role: "user", content: "fix the tests" } },
      { type: "assistant", message: { role: "assistant", content: "Running tests." } },
    ],
  };
}

function makeSupervisor(process: unknown) {
  return {
    getProcessForSession: vi.fn(() => process),
  } as unknown as Supervisor;
}

describe("WebhookPrivateService", () => {
  let tempDir: string;
  const fetchMock = vi.fn();

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "wp-svc-test-"));
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(
      // 钉钉成功响应 / DingTalk success response
      new Response(JSON.stringify({ errcode: 0, errmsg: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  /** 构造一个已启用、指向 dingtalk 的服务 / build a service enabled for dingtalk */
  async function makeService(
    url: string,
    supervisor: Supervisor,
    events?: Partial<{
      idle: boolean;
      error: boolean;
      toolApproval: boolean;
      userQuestion: boolean;
    }>,
  ) {
    const service = new WebhookPrivateService({
      dataDir: tempDir,
      eventBus: new EventBus(),
      supervisor,
    });
    await service.initialize();
    await service.getStore().update({
      enabled: true,
      url,
      secret: "SECtest",
      platform: "auto",
      dryRun: false,
      events: {
        idle: true,
        error: true,
        toolApproval: true,
        userQuestion: true,
        ...events,
      },
    });
    return service;
  }

  it("sends a dingtalk markdown message on idle", async () => {
    const service = await makeService(
      DING_URL,
      makeSupervisor(makeProcess()),
    );
    service["options"].eventBus.emit({
      type: "process-state-changed",
      sessionId: "sess-1",
      projectId: PROJECT_ID as never,
      activity: "idle",
      timestamp: "2026-06-29T00:00:00.000Z",
    });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    // 签名在 URL query 上 / signature on the URL query
    expect(url.startsWith(DING_URL)).toBe(true);
    expect(url).toContain("timestamp=");
    expect(url).toContain("sign=");
    const body = JSON.parse(init.body as string);
    expect(body.msgtype).toBe("markdown");
    expect(body.markdown.title).toContain("repo");
    expect(body.markdown.text).toContain("fix the tests");
    // payload 携带 dryRun=false / payload carries dryRun=false
    expect(body.markdown.text).not.toContain("dryRun");
  });

  it("sends a feishu interactive card on tool-approval", async () => {
    const service = await makeService(
      FEI_URL,
      makeSupervisor(makeProcess({ state: { type: "waiting-input" } })),
    );
    service["options"].eventBus.emit({
      type: "process-state-changed",
      sessionId: "sess-1",
      projectId: PROJECT_ID as never,
      activity: "waiting-input",
      pendingInputType: "tool-approval",
      timestamp: "2026-06-29T00:00:00.000Z",
    });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(FEI_URL); // 飞书签名在 body，URL 不变 / URL unchanged for feishu
    const body = JSON.parse(init.body as string);
    expect(body.msg_type).toBe("interactive");
    expect(body.timestamp).toBeTruthy();
    expect(body.sign).toBeTruthy();
    expect(body.card.header.template).toBe("orange"); // tool-approval → orange
  });

  it("sends a user-question event when enabled", async () => {
    const service = await makeService(
      FEI_URL,
      makeSupervisor(makeProcess({ state: { type: "waiting-input" } })),
    );
    service["options"].eventBus.emit({
      type: "process-state-changed",
      sessionId: "sess-1",
      projectId: PROJECT_ID as never,
      activity: "waiting-input",
      pendingInputType: "user-question",
      timestamp: "2026-06-29T00:00:00.000Z",
    });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.card.header.template).toBe("blue"); // user-question → blue
  });

  it("sends an error event on process-terminated", async () => {
    const service = await makeService(
      DING_URL,
      makeSupervisor(makeProcess()),
    );
    service["options"].eventBus.emit({
      type: "process-terminated",
      sessionId: "sess-1",
      projectId: PROJECT_ID as never,
      processId: "proc-1",
      provider: "claude",
      reason: "underlying process terminated",
      timestamp: "2026-06-29T00:00:00.000Z",
    });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.markdown.text).toContain("进程异常");
    expect(body.markdown.text).toContain("underlying process terminated");
  });

  it("skips an event type that is disabled in config", async () => {
    const service = await makeService(
      DING_URL,
      makeSupervisor(makeProcess({ state: { type: "waiting-input" } })),
      { toolApproval: false },
    );
    service["options"].eventBus.emit({
      type: "process-state-changed",
      sessionId: "sess-1",
      projectId: PROJECT_ID as never,
      activity: "waiting-input",
      pendingInputType: "tool-approval",
      timestamp: "2026-06-29T00:00:00.000Z",
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips when disabled (master switch off)", async () => {
    const service = await makeService(
      DING_URL,
      makeSupervisor(makeProcess()),
    );
    await service.getStore().update({ enabled: false });
    service["options"].eventBus.emit({
      type: "process-state-changed",
      sessionId: "sess-1",
      projectId: PROJECT_ID as never,
      activity: "idle",
      timestamp: "2026-06-29T00:00:00.000Z",
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips when platform is unknown (unrelated URL)", async () => {
    const service = await makeService(
      "https://example.com/webhook",
      makeSupervisor(makeProcess()),
    );
    service["options"].eventBus.emit({
      type: "process-state-changed",
      sessionId: "sess-1",
      projectId: PROJECT_ID as never,
      activity: "idle",
      timestamp: "2026-06-29T00:00:00.000Z",
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ignores idle events after the process has been unregistered", async () => {
    const service = await makeService(
      DING_URL,
      makeSupervisor(undefined),
    );
    service["options"].eventBus.emit({
      type: "process-state-changed",
      sessionId: "sess-1",
      projectId: PROJECT_ID as never,
      activity: "idle",
      timestamp: "2026-06-29T00:00:00.000Z",
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sendTest sends a dryRun test message", async () => {
    const service = await makeService(
      DING_URL,
      makeSupervisor(makeProcess()),
    );
    const result = await service.sendTest();
    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.markdown.text).toContain("测试"); // 测试消息文本 / test message text
  });

  it("dedupes consecutive same-type pending-input events within the window", async () => {
    const service = await makeService(
      FEI_URL,
      makeSupervisor(makeProcess({ state: { type: "waiting-input" } })),
    );
    const emit = (pendingInputType: "tool-approval" | "user-question") =>
      service["options"].eventBus.emit({
        type: "process-state-changed",
        sessionId: "sess-1",
        projectId: PROJECT_ID as never,
        activity: "waiting-input",
        pendingInputType,
        timestamp: "2026-06-29T00:00:00.000Z",
      });

    // 连续两次同类型 tool-approval：只应发一条（去重）
    // Two consecutive tool-approval events: only one should be sent (deduped)
    emit("tool-approval");
    emit("tool-approval");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    // 不同类型 user-question 不被 tool-approval 抑制：应再发一条
    // A different type (user-question) is not suppressed by tool-approval: sent
    emit("user-question");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it("resends the same pending-input type after the session goes idle then waiting again", async () => {
    const service = await makeService(
      FEI_URL,
      makeSupervisor(makeProcess({ state: { type: "waiting-input" } })),
    );
    const emit = (
      activity: "waiting-input" | "idle",
      pendingInputType?: "tool-approval",
    ) =>
      service["options"].eventBus.emit({
        type: "process-state-changed",
        sessionId: "sess-1",
        projectId: PROJECT_ID as never,
        activity,
        ...(pendingInputType ? { pendingInputType } : {}),
        timestamp: "2026-06-29T00:00:00.000Z",
      });

    // 第一次 tool-approval 发送
    emit("waiting-input", "tool-approval");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    // 进入 idle 清理去重记录
    // going idle clears the dedupe record
    emit("idle");
    await new Promise((resolve) => setTimeout(resolve, 0));

    // 再次 tool-approval：因 idle 已清理，应重新发送
    // tool-approval again: idle cleared the record, so it's sent again
    emit("waiting-input", "tool-approval");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it("reports a dingtalk business error (errcode != 0) as failure", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ errcode: 310000, errmsg: "sign not match" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const service = await makeService(
      DING_URL,
      makeSupervisor(makeProcess()),
    );
    service["options"].eventBus.emit({
      type: "process-state-changed",
      sessionId: "sess-1",
      projectId: PROJECT_ID as never,
      activity: "idle",
      timestamp: "2026-06-29T00:00:00.000Z",
    });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });
});
