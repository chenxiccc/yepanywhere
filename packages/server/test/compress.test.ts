import { Hono } from "hono";
import { compress } from "hono/compress";
import { streamSSE } from "hono/streaming";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";

/**
 * Compression middleware behavior tests.
 * 压缩中间件行为测试。
 *
 * Uses a minimal self-contained Hono app instead of the full `createApp()` so
 * assertions are stable and not coupled to business-endpoint payload sizes.
 * 使用最小自包含 Hono app 而非完整 `createApp()`，使断言稳定、不耦合业务端点的响应体积。
 *
 * Note on the threshold: hono/compress skips responses below `threshold` by
 * checking the `Content-Length` header. In the in-memory test Request path,
 * `c.json()` does not set `Content-Length`, so the threshold check is bypassed
 * and every JSON response compresses. To test the threshold behavior faithfully,
 * we mount an explicit small response that carries a `Content-Length` header.
 * 阈值说明：hono/compress 通过 `Content-Length` 头判断是否低于阈值跳过压缩。
 * 在内存测试 Request 路径中 `c.json()` 不设 `Content-Length`，阈值检查被绕过，
 * 所有 JSON 响应都会被压缩。为如实测试阈值行为，我们挂一个显式带 `Content-Length` 头的小响应。
 */

// Build a large JSON payload well above the 1024-byte threshold.
// 构造远超 1024 字节阈值的大 JSON 载荷。
function largePayload(): Record<string, string> {
  const padding = "x".repeat(8192);
  return { padding, note: "large payload for compression test" };
}

function buildApp(): Hono {
  const app = new Hono();
  app.use("*", compress({ threshold: 1024 }));

  app.get("/large", (c) => c.json(largePayload()));
  // Small response WITH an explicit Content-Length, to exercise the threshold.
  // 带 Content-Length 的小响应，用于测试阈值。
  app.get("/small", (_c) => {
    const body = JSON.stringify({ ok: true });
    return new Response(body, {
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(new TextEncoder().encode(body).length),
      },
    });
  });
  app.get("/sse", (c) =>
    streamSSE(c, async (stream) => {
      await stream.write("data: hello\n\n");
      await stream.write("data: world\n\n");
    }),
  );

  return app;
}

describe("compress middleware", () => {
  it("gzip-encodes large JSON when client sends Accept-Encoding: gzip", async () => {
    const app = buildApp();
    const res = await app.request("/large", {
      headers: { "Accept-Encoding": "gzip" },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBe("gzip");

    // The test Request path does NOT transparently decompress (unlike real
    // browsers / Node fetch, where Response.json() decodes gzip automatically).
    // Decompress manually to prove the bytes are a valid gzip of the JSON.
    // 测试 Request 路径不会透明解压（真实浏览器 / Node fetch 的 Response.json() 会自动解码 gzip）。
    // 手动解压以证明字节是合法的 JSON 的 gzip。
    const buf = Buffer.from(await res.arrayBuffer());
    const decoded = gunzipSync(buf).toString("utf-8");
    const json = JSON.parse(decoded) as { padding: string };
    expect(json.padding.length).toBe(8192);
  });

  it("does not compress responses below the threshold", async () => {
    const app = buildApp();
    const res = await app.request("/small", {
      headers: { "Accept-Encoding": "gzip" },
    });

    expect(res.status).toBe(200);
    // A response with Content-Length < threshold must skip compression.
    // Content-Length < 阈值的响应必须跳过压缩。
    expect(res.headers.get("content-encoding")).toBeNull();
  });

  it("does not compress when client sends no Accept-Encoding", async () => {
    const app = buildApp();
    const res = await app.request("/large");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBeNull();
    const json = (await res.json()) as { padding: string };
    expect(json.padding.length).toBe(8192);
  });

  it("does not compress SSE streams", async () => {
    const app = buildApp();
    const res = await app.request("/sse", {
      headers: { "Accept-Encoding": "gzip" },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBeNull();
    const contentType = res.headers.get("content-type") ?? "";
    expect(contentType.startsWith("text/event-stream")).toBe(true);
  });

  it("does not compress HEAD requests", async () => {
    const app = buildApp();
    const res = await app.request("/large", {
      method: "HEAD",
      headers: { "Accept-Encoding": "gzip" },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBeNull();
  });
});
