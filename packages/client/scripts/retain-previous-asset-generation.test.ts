import { createHash } from "node:crypto";
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

function asset(path: string, body: string, contentType: string) {
  const bytes = Buffer.from(body);
  return {
    path,
    size: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    contentType,
  };
}

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
          schemaVersion: 2,
          assets: [
            asset("assets/main-Old_Hash.js", "old", "application/javascript"),
            asset("assets/shared-SameHash.css", "shared", "text/css"),
          ],
        });
      }
      if (url.endsWith("/assets/main-Old_Hash.js")) {
        return new Response("old", {
          headers: { "Content-Type": "application/javascript" },
        });
      }
      if (url.endsWith("/assets/shared-SameHash.css")) {
        return new Response("shared", {
          headers: { "Content-Type": "text/css; charset=utf-8" },
        });
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
      schemaVersion: 2,
      assets: [
        asset("assets/main-New_Hash.js", "new", "application/javascript"),
      ],
    });
    expect(requests).toHaveLength(3);
  });

  it("requires an explicit one-time bootstrap for the SPA fallback", async () => {
    const distPath = await createRemoteBuild();
    const fetchImpl = async () =>
      new Response("<html></html>", {
        headers: { "Content-Type": "text/html" },
      });

    await expect(
      retainPreviousAssetGeneration({
        distPath,
        previousOrigin: "https://latest.example/",
        fetchImpl,
      }),
    ).rejects.toThrow("Previous asset manifest returned text/html");

    const result = await retainPreviousAssetGeneration({
      distPath,
      previousOrigin: "https://latest.example/",
      bootstrap: true,
      fetchImpl,
    });

    expect(result.previousManifestFound).toBe(false);
    expect(result.retainedAssetCount).toBe(0);

    await expect(
      retainPreviousAssetGeneration({
        distPath,
        previousOrigin: "https://latest.example/",
        bootstrap: true,
        fetchImpl: async () => Response.json({ schemaVersion: 2, assets: [] }),
      }),
    ).rejects.toThrow("a previous asset manifest exists");

    await expect(
      retainPreviousAssetGeneration({
        distPath,
        previousOrigin: "https://latest.example/",
        fetchImpl: async () => new Response("missing", { status: 404 }),
      }),
    ).rejects.toThrow("--bootstrap is required");
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
                schemaVersion: 2,
                assets: [
                  asset(
                    "assets/main-Old_Hash.js",
                    "old",
                    "application/javascript",
                  ),
                ],
              })
            : new Response("missing", { status: 404 }),
      }),
    ).rejects.toThrow("Previous asset request failed");
  });

  it("rejects 200 HTML asset fallbacks and metadata mismatches", async () => {
    const cases = [
      {
        name: "type",
        metadata: asset(
          "assets/main-Old_Hash.js",
          "old",
          "application/javascript",
        ),
        response: new Response("<html>fallback</html>", {
          headers: { "Content-Type": "text/html" },
        }),
        error: "Previous asset type mismatch",
      },
      {
        name: "size",
        metadata: {
          ...asset("assets/main-Old_Hash.js", "old", "application/javascript"),
          size: 99,
        },
        response: new Response("old", {
          headers: { "Content-Type": "application/javascript" },
        }),
        error: "Previous asset size mismatch",
      },
      {
        name: "hash",
        metadata: {
          ...asset("assets/main-Old_Hash.js", "old", "application/javascript"),
          sha256: "0".repeat(64),
        },
        response: new Response("old", {
          headers: { "Content-Type": "application/javascript" },
        }),
        error: "Previous asset SHA-256 mismatch",
      },
    ];

    for (const testCase of cases) {
      const distPath = await createRemoteBuild();
      await expect(
        retainPreviousAssetGeneration({
          distPath,
          previousOrigin: "https://latest.example/",
          fetchImpl: async (input: URL | RequestInfo) =>
            String(input).endsWith("/asset-generation.json")
              ? Response.json({
                  schemaVersion: 2,
                  assets: [testCase.metadata],
                })
              : testCase.response.clone(),
        }),
        testCase.name,
      ).rejects.toThrow(testCase.error);
    }
  });

  it("transitions a legacy path manifest only with matching asset media", async () => {
    const distPath = await createRemoteBuild();

    const result = await retainPreviousAssetGeneration({
      distPath,
      previousOrigin: "https://latest.example/",
      fetchImpl: async (input: URL | RequestInfo) =>
        String(input).endsWith("/asset-generation.json")
          ? Response.json({
              schemaVersion: 1,
              assets: ["assets/main-Old_Hash.js"],
            })
          : new Response("legacy", {
              headers: { "Content-Type": "text/javascript" },
            }),
    });

    expect(result.retainedAssetCount).toBe(1);
    expect(
      await readFile(join(distPath, "assets", "main-Old_Hash.js"), "utf8"),
    ).toBe("legacy");
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
      bootstrap: false,
    });
    expect(
      parseArgs(["--previous-origin", "https://latest.example", "--bootstrap"]),
    ).toMatchObject({ bootstrap: true });
  });
});
