import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createOnboardingRoutes } from "../../src/routes/onboarding.js";

const testDirs: string[] = [];

async function createTestDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "yep-onboarding-test-"));
  testDirs.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(
    testDirs
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("onboarding routes", () => {
  it("keeps the ordinary first-run wizard for non-desktop servers", async () => {
    const routes = createOnboardingRoutes({ dataDir: await createTestDir() });

    const response = await routes.request("/");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ complete: false });
  });

  it("never gates the desktop dashboard on the web onboarding wizard", async () => {
    const routes = createOnboardingRoutes({
      dataDir: await createTestDir(),
      completeByDefault: true,
    });

    const initial = await routes.request("/");
    await routes.request("/reset", { method: "POST" });
    const afterReset = await routes.request("/");

    expect(await initial.json()).toEqual({ complete: true });
    expect(await afterReset.json()).toEqual({ complete: true });
  });
});
