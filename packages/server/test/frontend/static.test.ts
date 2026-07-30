import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createStaticRoutes,
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
