import { basename, extname } from "node:path";

const BROWSER_ACTIVE_EXTENSIONS = new Set([
  ".htm",
  ".html",
  ".svg",
  ".svgz",
  ".xht",
  ".xhtml",
  ".xml",
  ".xsl",
  ".xslt",
]);

const BROWSER_ACTIVE_MIME_TYPES = new Set([
  "application/xhtml+xml",
  "application/xml",
  "application/xslt+xml",
  "image/svg+xml",
  "text/html",
  "text/xml",
]);

export const UNTRUSTED_ACTIVE_CONTENT_CSP = [
  "sandbox",
  "default-src 'none'",
  "script-src 'none'",
  "connect-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "img-src data: blob:",
  "media-src data: blob:",
  "style-src 'unsafe-inline'",
].join("; ");

export const UNTRUSTED_ACTIVE_CONTENT_PERMISSIONS_POLICY = [
  "accelerometer=()",
  "camera=()",
  "geolocation=()",
  "gyroscope=()",
  "magnetometer=()",
  "microphone=()",
  "payment=()",
  "usb=()",
].join(", ");

type ContentDisposition = "attachment" | "inline";

interface UntrustedFileResponseHeadersOptions {
  baseHeaders?: HeadersInit;
  contentType?: string;
  disposition?: ContentDisposition;
  filePath: string;
}

function normalizedMimeType(contentType: string | null): string {
  return contentType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

export function isBrowserActiveContent(
  filePath: string,
  contentType: string | null,
): boolean {
  const mimeType = normalizedMimeType(contentType);
  return (
    BROWSER_ACTIVE_EXTENSIONS.has(extname(filePath).toLowerCase()) ||
    BROWSER_ACTIVE_MIME_TYPES.has(mimeType) ||
    mimeType.endsWith("+xml")
  );
}

function encodeDispositionFilename(fileName: string): string {
  return encodeURIComponent(fileName).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function asciiDispositionFilename(fileName: string): string {
  const fallback = Array.from(fileName, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint >= 0x20 &&
      codePoint <= 0x7e &&
      character !== '"' &&
      character !== "\\"
      ? character
      : "_";
  }).join("");
  return fallback || "file";
}

function contentDisposition(
  disposition: ContentDisposition,
  filePath: string,
): string {
  const fileName = basename(filePath) || "file";
  return `${disposition}; filename="${asciiDispositionFilename(fileName)}"; filename*=UTF-8''${encodeDispositionFilename(fileName)}`;
}

/**
 * Apply the native-navigation policy for project-, upload-, and agent-authored
 * files. Classification is metadata-only over the path and response MIME type;
 * it does not parse or sanitize file contents.
 */
export function createUntrustedFileResponseHeaders(
  options: UntrustedFileResponseHeadersOptions,
): Headers {
  const headers = new Headers(options.baseHeaders);
  if (options.contentType) {
    headers.set("Content-Type", options.contentType);
  }
  if (options.disposition) {
    headers.set(
      "Content-Disposition",
      contentDisposition(options.disposition, options.filePath),
    );
  }

  headers.set("X-Content-Type-Options", "nosniff");
  if (!isBrowserActiveContent(options.filePath, headers.get("Content-Type"))) {
    return headers;
  }

  headers.set(
    "Content-Disposition",
    contentDisposition("attachment", options.filePath),
  );
  headers.set("Content-Security-Policy", UNTRUSTED_ACTIVE_CONTENT_CSP);
  headers.set(
    "Permissions-Policy",
    UNTRUSTED_ACTIVE_CONTENT_PERMISSIONS_POLICY,
  );
  headers.set("Referrer-Policy", "no-referrer");
  return headers;
}
