/**
 * Gzip/deflate compression middleware for JSON REST responses.
 * JSON REST 响应的 gzip/deflate 压缩中间件。
 *
 * Uses hono's built-in compress (Web CompressionStream). Skips SSE
 * (text/event-stream), binary Content-Types, HEAD, and already-encoded
 * responses automatically via the middleware's skip-regex.
 * 使用 hono 内置 compress（Web CompressionStream）。通过中间件的跳过正则
 * 自动跳过 SSE（text/event-stream）、二进制 Content-Type、HEAD 请求以及已编码的响应。
 *
 * Register after auth so it wraps the response outermost and sees the final
 * Content-Type, letting the skip-regex correctly exclude SSE / binary.
 * 在 auth 之后注册，使其作为最外层包裹响应、能看到最终 Content-Type，
 * 从而让跳过正则正确排除 SSE / 二进制响应。
 *
 * Responses below the threshold are skipped to avoid CPU overhead for tiny
 * payloads. relay forwarding (app.fetch -> .json()) and publicShareService
 * decompress transparently, so this is safe for internal callers too.
 * 低于阈值的响应被跳过，以避免对极小载荷的 CPU 开销。relay 转发
 * （app.fetch -> .json()）与 publicShareService 会透明解压，故对内部调用方也安全。
 */
import { compress } from "hono/compress";

/** Compression threshold in bytes; smaller responses skip compression. */
// 压缩阈值（字节）；更小的响应跳过压缩。
const COMPRESS_THRESHOLD_BYTES = 1024;

export function createCompressMiddleware() {
  return compress({ threshold: COMPRESS_THRESHOLD_BYTES });
}
