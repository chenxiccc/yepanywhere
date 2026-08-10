import { describe, expect, it } from "vitest";
import {
  CAPABILITY_ID_ALLOCATIONS,
  CAPABILITY_ID_ENCODING_VERSION,
  DEVICE_BRIDGE_CAPABILITY,
  DEVICE_BRIDGE_UPDATE_CAPABILITY,
  PROJECT_SESSION_DEFAULTS_CAPABILITY,
  PUBLIC_SHARE_SESSION_CHUNKS_CAPABILITY,
  VOICE_INPUT_CAPABILITY,
  encodeCompactServerCapabilities,
  encodeOptionalServerCapabilityBits,
  encodeVersionedServerCapabilities,
  hasServerCapabilityAdvertisement,
  negotiateServerCapabilityEncoding,
  serverHasCapability,
} from "../index.js";

describe("server capability advertisements", () => {
  it("distinguishes absent legacy advertisements from empty ID sets", () => {
    expect(hasServerCapabilityAdvertisement({ current: "0.7.0" })).toBe(false);
    expect(
      hasServerCapabilityAdvertisement({
        capabilityEncoding: CAPABILITY_ID_ENCODING_VERSION,
        capabilityBits: [],
      }),
    ).toBe(true);
  });

  it("infers monotonic capabilities from the server release", () => {
    expect(
      serverHasCapability(
        { current: "0.7.1" },
        PROJECT_SESSION_DEFAULTS_CAPABILITY,
      ),
    ).toBe(true);
    expect(
      serverHasCapability(
        { current: "0.7.1-3-gabcdef" },
        PROJECT_SESSION_DEFAULTS_CAPABILITY,
      ),
    ).toBe(true);
    expect(
      serverHasCapability(
        { current: "0.7.1-beta.1" },
        PROJECT_SESSION_DEFAULTS_CAPABILITY,
      ),
    ).toBe(false);
    expect(
      serverHasCapability(
        { current: "0.7.0" },
        PROJECT_SESSION_DEFAULTS_CAPABILITY,
      ),
    ).toBe(false);
  });

  it("encodes optional capability presence in sparse 32-bit words", () => {
    const optionalCapabilityBits = encodeOptionalServerCapabilityBits([
      VOICE_INPUT_CAPABILITY,
      DEVICE_BRIDGE_UPDATE_CAPABILITY,
      VOICE_INPUT_CAPABILITY,
    ]);
    const source = { current: "99.0.0", optionalCapabilityBits };

    expect(optionalCapabilityBits).toEqual([[0, 17]]);
    expect(serverHasCapability(source, VOICE_INPUT_CAPABILITY)).toBe(true);
    expect(serverHasCapability(source, DEVICE_BRIDGE_UPDATE_CAPABILITY)).toBe(
      true,
    );
    expect(serverHasCapability(source, DEVICE_BRIDGE_CAPABILITY)).toBe(false);
  });

  it("keeps only not-yet-released names as compact extensions", () => {
    const capabilities = [
      PROJECT_SESSION_DEFAULTS_CAPABILITY,
      VOICE_INPUT_CAPABILITY,
    ];

    expect(encodeCompactServerCapabilities(capabilities, "0.7.1")).toEqual({
      optionalCapabilityBits: [[0, 1]],
    });
    expect(
      encodeCompactServerCapabilities(capabilities, "0.7.0-741-gabcdef"),
    ).toEqual({
      optionalCapabilityBits: [[0, 1]],
      capabilityExtensions: [PROJECT_SESSION_DEFAULTS_CAPABILITY],
    });
  });

  it("encodes source-ahead capabilities by permanent ID", () => {
    const capabilities = [
      PROJECT_SESSION_DEFAULTS_CAPABILITY,
      VOICE_INPUT_CAPABILITY,
    ];

    expect(encodeVersionedServerCapabilities(capabilities, "0.7.1")).toEqual({
      capabilityEncoding: CAPABILITY_ID_ENCODING_VERSION,
      capabilityBits: [[0, 1]],
    });

    const sourceAdvertisement = encodeVersionedServerCapabilities(
      capabilities,
      "0.7.0-741-gabcdef",
    );
    expect(sourceAdvertisement).toEqual({
      capabilityEncoding: CAPABILITY_ID_ENCODING_VERSION,
      capabilityBits: [
        [0, 2 ** CAPABILITY_ID_ALLOCATIONS.projectSessionDefaults.id + 1],
      ],
    });
    expect(
      serverHasCapability(
        { current: "0.7.0-741-gabcdef", ...sourceAdvertisement },
        PROJECT_SESSION_DEFAULTS_CAPABILITY,
      ),
    ).toBe(true);
  });

  it("chooses the newest mutually supported capability encoding", () => {
    expect(negotiateServerCapabilityEncoding(undefined, "0.7.1")).toBeNull();
    expect(negotiateServerCapabilityEncoding("0.7.0", "0.7.1")).toBeNull();
    expect(negotiateServerCapabilityEncoding("0.7.1-beta.1", "0.7.1")).toBe(
      CAPABILITY_ID_ENCODING_VERSION,
    );
    expect(
      negotiateServerCapabilityEncoding(
        "0.7.0-741-gabcdef",
        "0.7.0-750-g1234567",
      ),
    ).toBe(CAPABILITY_ID_ENCODING_VERSION);
    expect(negotiateServerCapabilityEncoding("99.0.0", "0.7.1")).toBe(
      CAPABILITY_ID_ENCODING_VERSION,
    );
  });

  it("keeps legacy and scoped capability-name checks", () => {
    expect(
      serverHasCapability(
        { capabilities: [PUBLIC_SHARE_SESSION_CHUNKS_CAPABILITY] },
        PUBLIC_SHARE_SESSION_CHUNKS_CAPABILITY,
      ),
    ).toBe(true);
    expect(
      serverHasCapability(
        {
          current: "0.7.0-741-gabcdef",
          capabilityExtensions: [PROJECT_SESSION_DEFAULTS_CAPABILITY],
        },
        PROJECT_SESSION_DEFAULTS_CAPABILITY,
      ),
    ).toBe(true);
  });
});
