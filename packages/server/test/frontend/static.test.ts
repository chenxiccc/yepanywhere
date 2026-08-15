import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createStaticRoutes,
  isImmutableClientAssetPath,
  isPathInsideDirectory,
} from "../../src/frontend/static.js";

describe("static file path containment", () => {
  it("rejects sibling paths that share the dist directory prefix", () => {
    const root = path.resolve("/tmp/yep-static-test/dist");
    const sibling = path.resolve("/tmp/yep-static-test/dist-secret/file.txt");

    expect(isPathInsideDirectory(path.join(root, "assets/app.js"), root)).toBe(
      true,
    );
    expect(isPathInsideDirectory(sibling, root)).toBe(false);
    expect(
      isPathInsideDirectory(path.resolve(root, "../secret.txt"), root),
    ).toBe(false);
  });
});

describe("static asset cache headers", () => {
  it("recognizes the Vite asset namespace without assuming hex hashes", () => {
    expect(isImmutableClientAssetPath("/assets/main-xsEJeyVm.js")).toBe(true);
    expect(isImmutableClientAssetPath("/assets/useActivity--Osp0_q4.js")).toBe(
      true,
    );
    expect(isImmutableClientAssetPath("/assets/index-BPXPYV9_.css")).toBe(true);
    expect(isImmutableClientAssetPath("/index.html")).toBe(false);
    expect(isImmutableClientAssetPath("/sw.js")).toBe(false);
    expect(isImmutableClientAssetPath("/assets/nested/file.js")).toBe(false);
  });

  it("serves generated assets as immutable and entry files as mutable", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "yep-static-test-"));
    try {
      fs.mkdirSync(path.join(root, "assets"));
      fs.writeFileSync(path.join(root, "assets", "main-BPXPYV9_.js"), "js");
      fs.writeFileSync(path.join(root, "sw.js"), "sw");
      fs.writeFileSync(path.join(root, "index.html"), "<main>YA</main>");
      const routes = createStaticRoutes({ distPath: root });

      const assetResponse = await routes.request("/assets/main-BPXPYV9_.js");
      const workerResponse = await routes.request("/sw.js");

      expect(assetResponse.headers.get("cache-control")).toBe(
        "public, max-age=31536000, immutable",
      );
      expect(workerResponse.headers.get("cache-control")).toBe(
        "public, max-age=0, must-revalidate",
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("static app document security headers", () => {
  it("serves the app with a restrictive content security policy", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "yep-static-test-"));
    try {
      fs.writeFileSync(path.join(root, "index.html"), "<main>YA</main>");
      const routes = createStaticRoutes({ distPath: root });

      const response = await routes.request("/");
      const policy = response.headers.get("content-security-policy");

      expect(response.status).toBe(200);
      expect(policy).toContain("default-src 'self'");
      expect(policy).toContain("object-src 'none'");
      expect(policy).toContain("connect-src 'self' http: https: ws: wss:");
      expect(policy).toContain(
        "frame-ancestors 'self' tauri://localhost https://tauri.localhost",
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
