import { describe, expect, it } from "vitest";
import {
  UNTRUSTED_ACTIVE_CONTENT_CSP,
  createUntrustedFileResponseHeaders,
  isBrowserActiveContent,
} from "../../src/routes/untrusted-file-response.js";

describe("untrusted file response policy", () => {
  it.each([
    ["page.html", "text/plain"],
    ["page.txt", "text/html; charset=utf-8"],
    ["diagram.svg", "image/svg+xml"],
    ["feed.data", "application/atom+xml"],
    ["transform.xsl", "application/octet-stream"],
  ])("classifies %s with %s as browser-active", (filePath, contentType) => {
    expect(isBrowserActiveContent(filePath, contentType)).toBe(true);
  });

  it.each([
    ["notes.txt", "text/plain"],
    ["data.json", "application/json"],
    ["photo.png", "image/png"],
  ])("keeps %s with %s inert", (filePath, contentType) => {
    expect(isBrowserActiveContent(filePath, contentType)).toBe(false);
  });

  it("forces active content to download with scriptless response headers", () => {
    const headers = createUntrustedFileResponseHeaders({
      contentType: "text/html; charset=utf-8",
      disposition: "inline",
      filePath: "project's proof.html",
    });

    expect(headers.get("Content-Disposition")).toContain("attachment");
    expect(headers.get("Content-Disposition")).toContain(
      "filename*=UTF-8''project%27s%20proof.html",
    );
    expect(headers.get("Content-Security-Policy")).toBe(
      UNTRUSTED_ACTIVE_CONTENT_CSP,
    );
    expect(headers.get("Permissions-Policy")).toContain("camera=()");
    expect(headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("does not add active-document restrictions to inert content", () => {
    const headers = createUntrustedFileResponseHeaders({
      contentType: "image/png",
      filePath: "plot.png",
    });

    expect(headers.get("Content-Disposition")).toBeNull();
    expect(headers.get("Content-Security-Policy")).toBeNull();
    expect(headers.get("X-Content-Type-Options")).toBe("nosniff");
  });
});
