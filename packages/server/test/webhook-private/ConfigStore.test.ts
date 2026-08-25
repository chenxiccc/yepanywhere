import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebhookPrivateConfigStore } from "../../src/webhook-private/WebhookPrivateConfigStore.js";
import { DEFAULT_WEBHOOK_PRIVATE_CONFIG } from "../../src/webhook-private/types.js";

describe("WebhookPrivateConfigStore", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "webhook-private-test-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("starts from defaults when the file does not exist (ENOENT)", async () => {
    const store = new WebhookPrivateConfigStore({ dataDir: tempDir });
    await store.initialize();
    const config = store.get();
    expect(config).toEqual(DEFAULT_WEBHOOK_PRIVATE_CONFIG);
    expect(store.getFilePath()).toBe(
      path.join(tempDir, "webhook-private.json"),
    );
  });

  it("persists and reloads config from disk", async () => {
    const store = new WebhookPrivateConfigStore({ dataDir: tempDir });
    await store.initialize();
    await store.update({
      enabled: true,
      url: "https://oapi.dingtalk.com/robot/send?access_token=x",
      secret: "SECsecret",
      platform: "dingtalk",
      dryRun: false,
      events: { idle: false, error: true, toolApproval: false, userQuestion: true },
    });

    // 新实例从同一目录加载 / a new instance loads from the same dir
    const reloaded = new WebhookPrivateConfigStore({ dataDir: tempDir });
    await reloaded.initialize();
    const config = reloaded.get();
    expect(config.enabled).toBe(true);
    expect(config.url).toContain("oapi.dingtalk.com");
    expect(config.secret).toBe("SECsecret");
    expect(config.platform).toBe("dingtalk");
    expect(config.dryRun).toBe(false);
    expect(config.events.idle).toBe(false);
    expect(config.events.toolApproval).toBe(false);
  });

  it("merges a partial patch and keeps other fields unchanged", async () => {
    const store = new WebhookPrivateConfigStore({ dataDir: tempDir });
    await store.initialize();
    await store.update({ enabled: true, url: "https://x" });
    // 只改一个 event 开关 / flip a single event toggle
    const config = await store.update({ events: { idle: false } });
    expect(config.enabled).toBe(true); // 保留 / preserved
    expect(config.url).toBe("https://x"); // 保留 / preserved
    expect(config.events.idle).toBe(false); // 更新 / updated
    expect(config.events.error).toBe(true); // 保留默认 / preserved default
    expect(config.events.toolApproval).toBe(true);
  });

  it("ignores unknown and invalid fields in a patch (whitelist)", async () => {
    const store = new WebhookPrivateConfigStore({ dataDir: tempDir });
    await store.initialize();
    const config = await store.update({
      // @ts-expect-error 未知字段应被忽略 / unknown field must be ignored
      unknownField: "should-be-ignored",
      platform: "invalid-platform" as never, // 非法枚举应被忽略 / invalid enum must be ignored
      enabled: true,
    });
    expect(config.platform).toBe("auto"); // 仍是默认 / still the default
    expect(config.enabled).toBe(true);
  });

  it("writes atomically (no leftover .tmp file after save)", async () => {
    const store = new WebhookPrivateConfigStore({ dataDir: tempDir });
    await store.initialize();
    await store.update({ enabled: true });

    const files = await fs.readdir(tempDir);
    expect(files).toContain("webhook-private.json");
    expect(files).not.toContain("webhook-private.json.tmp");
  });

  it("merges a partial on-disk object with defaults on load", async () => {
    // 手写一个只有部分字段的文件 / hand-write a partial file
    await fs.writeFile(
      path.join(tempDir, "webhook-private.json"),
      JSON.stringify({ version: 1, enabled: true, url: "https://x" }),
      "utf-8",
    );
    const store = new WebhookPrivateConfigStore({ dataDir: tempDir });
    await store.initialize();
    const config = store.get();
    expect(config.enabled).toBe(true);
    expect(config.url).toBe("https://x");
    // 缺失字段用默认补齐 / missing fields filled from defaults
    expect(config.platform).toBe("auto");
    expect(config.events.idle).toBe(true);
    expect(config.dryRun).toBe(true);
  });

  it("throws when accessed before initialize()", () => {
    const store = new WebhookPrivateConfigStore({ dataDir: tempDir });
    expect(() => store.get()).toThrow(/not initialized/i);
  });
});
