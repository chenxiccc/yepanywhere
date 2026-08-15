import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseArgs,
  retainPreviousAssetGeneration,
  validateAssetGenerationManifest,
} from "./retain-previous-asset-generation.mjs";

const temporaryDirectories: string[] = [];

async function createRemoteBuild() {
  const distPath = await mkdtemp(join(tmpdir(), "ya-asset-generation-"));
  temporaryDirectories.push(distPath);
  await mkdir(join(distPath, "assets"));
  await writeFile(join(distPath, "assets", "main-New_Hash.js"), "new");
  await writeFile(join(distPath, "assets", "main-New_Hash.js.map"), "map");
  return distPath;
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("previous asset generation retention", () => {
  it("retains old runtime assets but manifests only the current generation", async () => {
    const distPath = await createRemoteBuild();
    const requests: string[] = [];
    const fetchImpl = async (input: URL | RequestInfo) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith("/asset-generation.json")) {
        return Response.json({
          schemaVersion: 1,
          assets: ["assets/main-Old_Hash.js", "assets/shared-SameHash.css"],
        });
      }
      if (url.endsWith("/assets/main-Old_Hash.js")) {
        return new Response("old");
      }
      if (url.endsWith("/assets/shared-SameHash.css")) {
        return new Response("shared");
      }
      return new Response("missing", { status: 404 });
    };

    const result = await retainPreviousAssetGeneration({
      distPath,
      previousOrigin: "https://latest.example/",
      fetchImpl,
    });

    expect(result).toEqual({
      currentAssetCount: 1,
      retainedAssetCount: 2,
      previousManifestFound: true,
    });
    expect(
      await readFile(join(distPath, "assets", "main-Old_Hash.js"), "utf8"),
    ).toBe("old");
    expect(
      JSON.parse(
        await readFile(join(distPath, "asset-generation.json"), "utf8"),
      ),
    ).toEqual({
      schemaVersion: 1,
      assets: ["assets/main-New_Hash.js"],
    });
    expect(requests).toHaveLength(3);
  });

  it("accepts the pre-manifest SPA fallback only for initial rollout", async () => {
    const distPath = await createRemoteBuild();
    const result = await retainPreviousAssetGeneration({
      distPath,
      previousOrigin: "https://latest.example/",
      fetchImpl: async () =>
        new Response("<html></html>", {
          headers: { "Content-Type": "text/html" },
        }),
    });

    expect(result.previousManifestFound).toBe(false);
    expect(result.retainedAssetCount).toBe(0);
  });

  it("rejects traversal, duplicates, and missing prior assets", async () => {
    expect(() =>
      validateAssetGenerationManifest({
        schemaVersion: 1,
        assets: ["assets/../secret", "assets/../secret"],
      }),
    ).toThrow("normalized asset path");

    const distPath = await createRemoteBuild();
    await expect(
      retainPreviousAssetGeneration({
        distPath,
        previousOrigin: "https://latest.example/",
        fetchImpl: async (input: URL | RequestInfo) =>
          String(input).endsWith("/asset-generation.json")
            ? Response.json({
                schemaVersion: 1,
                assets: ["assets/main-Old_Hash.js"],
              })
            : new Response("missing", { status: 404 }),
      }),
    ).rejects.toThrow("Previous asset request failed");
  });

  it("parses explicit deployment inputs", () => {
    expect(
      parseArgs([
        "--dist",
        "packages/client/dist-remote",
        "--previous-origin",
        "https://latest.example",
      ]),
    ).toMatchObject({
      previousOrigin: "https://latest.example/",
    });
  });
});
