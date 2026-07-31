import { describe, expect, it } from "vitest";
import {
  generateOpaqueId,
  generateSecret,
  hashSecret,
  isGeneratedSecret,
  isOpaqueId,
  verifySecret,
} from "../src/credentials.js";

describe("push broker credentials", () => {
  it("generates URL-safe opaque ids and 256-bit secrets", () => {
    const id = generateOpaqueId();
    const secret = generateSecret();

    expect(id).toHaveLength(22);
    expect(secret).toHaveLength(43);
    expect(isOpaqueId(id)).toBe(true);
    expect(isGeneratedSecret(secret)).toBe(true);
    expect(generateOpaqueId()).not.toBe(id);
    expect(generateSecret()).not.toBe(secret);
  });

  it("verifies the hash without retaining plaintext", () => {
    const secret = generateSecret();
    const hash = hashSecret(secret);

    expect(hash).toHaveLength(32);
    expect(hash.toString("utf8")).not.toContain(secret);
    expect(verifySecret(secret, hash)).toBe(true);
    expect(verifySecret(generateSecret(), hash)).toBe(false);
    expect(verifySecret(secret, undefined)).toBe(false);
  });

  it("rejects malformed capability syntax", () => {
    expect(isOpaqueId("short")).toBe(false);
    expect(isOpaqueId("!".repeat(22))).toBe(false);
    expect(isGeneratedSecret("short")).toBe(false);
    expect(isGeneratedSecret("!".repeat(43))).toBe(false);
  });
});
