import { describe, expect, it } from "vitest";
import {
  CAPABILITY_ID_ALLOCATIONS,
  CAPABILITY_ID_ENCODING_VERSION,
  DEVICE_BRIDGE_CAPABILITY,
  DEVICE_BRIDGE_UPDATE_CAPABILITY,
  PROJECT_SESSION_DEFAULTS_CAPABILITY,
  PROVIDER_HOST_CONTROL_CAPABILITY,
  PUBLIC_SHARE_MANAGEMENT_FREEZE_CAPABILITY,
  PUBLIC_SHARE_SESSION_CHUNKS_CAPABILITY,
  SUBAGENT_MAX_DEPTH_SETTING_CAPABILITY,
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
    expect(
      serverHasCapability(
        { current: "0.7.1" },
        SUBAGENT_MAX_DEPTH_SETTING_CAPABILITY,
      ),
    ).toBe(true);
    expect(
      serverHasCapability(
        { current: "0.7.0" },
        SUBAGENT_MAX_DEPTH_SETTING_CAPABILITY,
      ),
    ).toBe(false);
    expect(CAPABILITY_ID_ALLOCATIONS.subagentMaxDepthSetting.id).toBe(34);
  });

  it("lets a negative bit override an otherwise implied capability", () => {
    const deniedCapabilityBits = [
      [0, 2 ** CAPABILITY_ID_ALLOCATIONS.projectSessionDefaults.id],
    ] as const;

    expect(
      serverHasCapability(
        {
          current: "0.7.1",
          capabilities: [PROJECT_SESSION_DEFAULTS_CAPABILITY],
          deniedCapabilityBits,
        },
        PROJECT_SESSION_DEFAULTS_CAPABILITY,
      ),
    ).toBe(false);
    expect(
      serverHasCapability(
        {
          current: "0.7.1",
          deniedCapabilityBits: [[31, 2 ** 7]],
        },
        PROJECT_SESSION_DEFAULTS_CAPABILITY,
      ),
    ).toBe(true);
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

  it("keeps provider-host control optional at its permanent id", () => {
    const optionalCapabilityBits = encodeOptionalServerCapabilityBits([
      PROVIDER_HOST_CONTROL_CAPABILITY,
    ]);
    expect(optionalCapabilityBits).toEqual([
      [0, 2 ** CAPABILITY_ID_ALLOCATIONS.providerHostControl.id],
    ]);
    expect(
      serverHasCapability(
        { current: "0.7.1", optionalCapabilityBits },
        PROVIDER_HOST_CONTROL_CAPABILITY,
      ),
    ).toBe(true);
    expect(
      serverHasCapability(
        { current: "0.7.1", optionalCapabilityBits: [] },
        PROVIDER_HOST_CONTROL_CAPABILITY,
      ),
    ).toBe(false);
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

  it("encodes selective share freeze in the second capability word", () => {
    const advertisement = encodeVersionedServerCapabilities(
      [PUBLIC_SHARE_MANAGEMENT_FREEZE_CAPABILITY],
      "0.7.0-741-gabcdef",
    );

    expect(advertisement).toEqual({
      capabilityEncoding: CAPABILITY_ID_ENCODING_VERSION,
      capabilityBits: [[1, 1]],
    });
    expect(
      serverHasCapability(
        { current: "0.7.0-741-gabcdef", ...advertisement },
        PUBLIC_SHARE_MANAGEMENT_FREEZE_CAPABILITY,
      ),
    ).toBe(true);
  });

  it("encodes withdrawals only when the release would imply support", () => {
    expect(
      encodeVersionedServerCapabilities([], "0.7.1", [
        PROJECT_SESSION_DEFAULTS_CAPABILITY,
      ]),
    ).toEqual({
      capabilityEncoding: CAPABILITY_ID_ENCODING_VERSION,
      capabilityBits: [],
      deniedCapabilityBits: [
        [0, 2 ** CAPABILITY_ID_ALLOCATIONS.projectSessionDefaults.id],
      ],
    });
    expect(
      encodeCompactServerCapabilities([], "0.7.0-741-gabcdef", [
        PROJECT_SESSION_DEFAULTS_CAPABILITY,
      ]),
    ).toEqual({ optionalCapabilityBits: [] });
    expect(() =>
      encodeVersionedServerCapabilities([], "0.7.1", [VOICE_INPUT_CAPABILITY]),
    ).toThrow("Only version-implied server capabilities can be denied");
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
