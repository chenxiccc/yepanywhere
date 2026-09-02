import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { dingtalkAdapter } from "../../src/webhook-private/adapters/dingtalk.js";
import { signDingtalk } from "../../src/webhook-private/adapters/dingtalk.js";
import { feishuAdapter } from "../../src/webhook-private/adapters/feishu.js";
import { signFeishu } from "../../src/webhook-private/adapters/feishu.js";
import { detectPlatform } from "../../src/webhook-private/adapters/index.js";
import type { WebhookPrivatePayload } from "../../src/webhook-private/types.js";

const SECRET = "SECtest123456";
const TIMESTAMP_MS = 1719600000000; // 固定毫秒时间戳 / fixed ms timestamp
const TIMESTAMP_SEC = 1719600000; // 固定秒时间戳 / fixed sec timestamp

/** 用 node:crypto 按钉钉官方算法独立计算参考签名 / Reference DingTalk signature via node:crypto */
function refDingtalkSign(secret: string, timestampMs: number): string {
  const stringToSign = `${timestampMs}\n${secret}`;
  // key = secret, message = timestamp + "\n" + secret
  const hmac = createHmac("sha256", secret).update(stringToSign, "utf8").digest();
  const b64 = Buffer.from(hmac).toString("base64");
  return encodeURIComponent(b64); // Base64 + URL encode
}

/** 用 node:crypto 按飞书官方算法独立计算参考签名 / Reference Feishu signature via node:crypto */
function refFeishuSign(secret: string, timestampSec: number): string {
  const stringToSign = `${timestampSec}\n${secret}`;
  // key = timestamp + "\n" + secret, message = 空串 / empty
  const hmac = createHmac("sha256", stringToSign).update("").digest();
  return Buffer.from(hmac).toString("base64"); // Base64, no URL encode
}

function makePayload(
  event: WebhookPrivatePayload["event"] = "idle",
): WebhookPrivatePayload {
  return {
    type: "session-inactive",
    event,
    timestamp: "2026-06-29T00:00:00.000Z",
    dryRun: true,
    session: { id: "session-1" },
    project: { id: "abc" as never, path: "/home/user/repo", name: "repo" },
    process: {
      id: "proc-1",
      provider: "claude",
      model: "claude-sonnet-4-5",
      executor: "cli",
      permissionMode: "default",
    },
    lastUserMessageText: "fix the tests",
    lastMessageText: "running tests now",
  };
}

describe("webhook-private adapters — signing", () => {
  it("dingtalk sign matches the official algorithm (ms timestamp, key=secret, URL-encoded Base64)", async () => {
    const { timestamp, sign } = await signDingtalk(SECRET, TIMESTAMP_MS);
    expect(timestamp).toBe(String(TIMESTAMP_MS));
    expect(sign).toBe(refDingtalkSign(SECRET, TIMESTAMP_MS));
  });

  it("feishu sign matches the official algorithm (sec timestamp, key=stringToSign, non-URL-encoded Base64)", async () => {
    const { timestamp, sign } = await signFeishu(SECRET, TIMESTAMP_SEC);
    expect(timestamp).toBe(String(TIMESTAMP_SEC));
    expect(sign).toBe(refFeishuSign(SECRET, TIMESTAMP_SEC));
  });

  it("dingtalk and feishu produce DIFFERENT signatures for the same secret (different algorithm)", async () => {
    const ding = await signDingtalk(SECRET, TIMESTAMP_MS);
    const fei = await signFeishu(SECRET, TIMESTAMP_SEC);
    expect(ding.sign).not.toBeNull();
    expect(fei.sign).not.toBeNull();
    // 钉钉结果可能含 %XX（URL encode），飞书结果不会含 %
    // DingTalk result may contain %XX (URL-encoded); Feishu result never contains %
    expect(ding.sign).not.toEqual(fei.sign);
  });
});

describe("webhook-private adapters — buildRequest", () => {
  const dingUrl =
    "https://oapi.dingtalk.com/robot/send?access_token=token123";
  const feiUrl = "https://open.feishu.cn/open-apis/bot/v2/hook/abc123";

  it("dingtalk puts signature in URL query and sends markdown body", async () => {
    const req = await dingtalkAdapter.buildRequest(
      makePayload("idle"),
      dingUrl,
      SECRET,
    );
    // 签名应出现在 URL query 上 / signature must be on the URL query
    expect(req.url).toContain("timestamp=");
    expect(req.url).toContain("sign=");
    expect(req.url.startsWith(dingUrl)).toBe(true); // 原始 URL 作为前缀
    // body 是 markdown 格式 / body is markdown format
    const body = req.body as { msgtype: string; markdown: { title: string; text: string } };
    expect(body.msgtype).toBe("markdown");
    expect(body.markdown.title).toContain("repo");
    expect(body.markdown.text).toContain("repo");
    expect(body.markdown.text).toContain("fix the tests");
    expect(req.headers["content-type"]).toBe("application/json");
  });

  it("feishu puts signature in body top-level and sends interactive card", async () => {
    const req = await feishuAdapter.buildRequest(
      makePayload("tool-approval"),
      feiUrl,
      SECRET,
    );
    // URL 保持不变 / URL unchanged
    expect(req.url).toBe(feiUrl);
    const body = req.body as {
      timestamp: string;
      sign: string;
      msg_type: string;
      card: { header: { title: { content: string }; template: string }; elements: unknown[] };
    };
    // 签名在 body 顶层 / signature at the top level of the body
    expect(body.timestamp).toBeTruthy();
    expect(body.sign).toBeTruthy();
    expect(body.msg_type).toBe("interactive");
    expect(body.card.header.title.content).toContain("repo");
    expect(body.card.header.template).toBe("orange"); // tool-approval → orange
    expect(body.card.elements.length).toBeGreaterThan(0);
  });

  it("dingtalk without secret sends to the raw URL with no signature", async () => {
    const req = await dingtalkAdapter.buildRequest(
      makePayload(),
      dingUrl,
      "",
    );
    expect(req.url).toBe(dingUrl);
    expect(req.url).not.toContain("sign=");
  });

  it("feishu without secret has no timestamp/sign in body", async () => {
    const req = await feishuAdapter.buildRequest(
      makePayload(),
      feiUrl,
      "",
    );
    const body = req.body as { timestamp?: string; sign?: string; msg_type: string };
    expect(body.timestamp).toBeUndefined();
    expect(body.sign).toBeUndefined();
    expect(body.msg_type).toBe("interactive");
  });
});

describe("webhook-private adapters — detectPlatform", () => {
  it("detects dingtalk by domain", () => {
    expect(detectPlatform("https://oapi.dingtalk.com/robot/send?access_token=x")).toBe("dingtalk");
  });

  it("detects feishu by domain", () => {
    expect(detectPlatform("https://open.feishu.cn/open-apis/bot/v2/hook/x")).toBe("feishu");
  });

  it("returns unknown for unrelated URLs", () => {
    expect(detectPlatform("https://example.com/webhook")).toBe("unknown");
    expect(detectPlatform("")).toBe("unknown");
  });

  it("is case-insensitive", () => {
    expect(detectPlatform("HTTPS://OAPI.DINGTALK.COM/robot/send")).toBe("dingtalk");
  });
});
