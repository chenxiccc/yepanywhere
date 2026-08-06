import { describe, expect, it } from "vitest";
import {
  createLruMap,
  createLruSet,
  refreshLruMap,
  refreshLruSet,
} from "../../src/lib/lruCollections.js";

describe("LRU collections", () => {
  it("moves a deleted and reinserted Set value to newest", () => {
    const values = createLruSet<string>();
    values.add("oldest");
    values.add("middle");
    values.add("newest");

    refreshLruSet(values, "middle");

    expect([...values]).toEqual(["oldest", "newest", "middle"]);
    expect(values.values().next().value).toBe("oldest");
  });

  it("moves a deleted and reinserted Map entry to newest", () => {
    const values = createLruMap<string, number>();
    values.set("oldest", 1);
    values.set("middle", 2);
    values.set("newest", 3);

    refreshLruMap(values, "middle", 4);

    expect([...values]).toEqual([
      ["oldest", 1],
      ["newest", 3],
      ["middle", 4],
    ]);
    expect(values.keys().next().value).toBe("oldest");
  });
});
