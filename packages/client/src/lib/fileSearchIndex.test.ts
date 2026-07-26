import { describe, expect, it } from "vitest";
import { FileSearchIndex } from "./fileSearchIndex";

describe("FileSearchIndex", () => {
  it("searches the complete normalized corpus and handles query edits", () => {
    const files = [
      "src/App.tsx",
      ...Array.from({ length: 600 }, (_, index) => `vendor/file-${index}.ts`),
      "packages/server/src/DeepNeedle.ts",
    ];
    const index = new FileSearchIndex(files);

    expect(index.search("deep")).toEqual(["packages/server/src/DeepNeedle.ts"]);
    expect(index.search("deepneedle")).toEqual([
      "packages/server/src/DeepNeedle.ts",
    ]);
    expect(index.search("APP")).toEqual(["src/App.tsx"]);
    expect(index.search("")).toBe(files);
  });
});
