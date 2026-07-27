import { describe, expect, it } from "vitest";
import de from "./de.json";
import en from "./en.json";
import es from "./es.json";
import fr from "./fr.json";
import ja from "./ja.json";
import zhCN from "./zh-CN.json";

/**
 * The catalogs are deliberately partial (missing keys fall back to English),
 * so full parity must NOT be asserted — only that no translation keeps a key
 * en.json no longer has, which would be dead weight that can never render.
 */
describe("locale catalogs", () => {
  const enKeys = new Set(Object.keys(en));
  for (const [name, catalog] of [
    ["de", de],
    ["es", es],
    ["fr", fr],
    ["ja", ja],
    ["zh-CN", zhCN],
  ] as const) {
    it(`${name} has no keys absent from en`, () => {
      const stale = Object.keys(catalog).filter((key) => !enKeys.has(key));
      expect(stale).toEqual([]);
    });
  }
});
