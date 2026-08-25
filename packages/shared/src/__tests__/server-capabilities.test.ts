import { describe, expect, it } from "vitest";
import {
  CAPABILITY_ID_ALLOCATIONS,
  CAPABILITY_ID_ENCODING_VERSION,
  CACHE_MISS_BILLING_EXPECTED_EXPIRY_CAPABILITY,
  CACHE_MISS_BILLING_IGNORE_AFTER_CAPABILITY,
  CLAUDE_GATEWAY_DISABLE_PLAN_MODE_CAPABILITY,
  CODEX_REASONING_SUMMARY_SETTING_CAPABILITY,
  CODEX_STREAM_DURABLE_ID_ALIGNMENT_CAPABILITY,
  DEVICE_BRIDGE_CAPABILITY,
  DEVICE_BRIDGE_UPDATE_CAPABILITY,
  GIT_FILE_REVISION_CAPABILITY,
  GIT_INCLUSIVE_TO_HEAD_CAPABILITY,
  GIT_INCOMING_COMMITS_CAPABILITY,
  GIT_LIVE_WORKTREE_SETTING_CAPABILITY,
  GIT_WORKING_TREE_COMPLETE_SCAN_CAPABILITY,
  GIT_WORKING_TREE_FILES_CAPABILITY,
  GIT_WORKING_TREE_SECTIONS_CAPABILITY,
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
    expect(
      serverHasCapability(
        { current: "0.7.1" },
        CODEX_REASONING_SUMMARY_SETTING_CAPABILITY,
      ),
    ).toBe(true);
    expect(
      serverHasCapability(
        { current: "0.7.0" },
        CODEX_REASONING_SUMMARY_SETTING_CAPABILITY,
      ),
    ).toBe(false);
    expect(CAPABILITY_ID_ALLOCATIONS.codexReasoningSummarySetting.id).toBe(35);
    expect(
      serverHasCapability(
        { current: "0.7.1" },
        CLAUDE_GATEWAY_DISABLE_PLAN_MODE_CAPABILITY,
      ),
    ).toBe(true);
    expect(
      serverHasCapability(
        { current: "0.7.0" },
        CLAUDE_GATEWAY_DISABLE_PLAN_MODE_CAPABILITY,
      ),
    ).toBe(false);
    expect(CAPABILITY_ID_ALLOCATIONS.claudeGatewayDisablePlanMode.id).toBe(36);
    expect(
      serverHasCapability(
        { current: "0.7.1" },
        GIT_WORKING_TREE_FILES_CAPABILITY,
      ),
    ).toBe(true);
    expect(
      serverHasCapability(
        { current: "0.7.0" },
        GIT_WORKING_TREE_FILES_CAPABILITY,
      ),
    ).toBe(false);
    expect(CAPABILITY_ID_ALLOCATIONS.gitWorkingTreeFiles.id).toBe(38);
    expect(
      serverHasCapability(
        { current: "0.7.1" },
        GIT_INCOMING_COMMITS_CAPABILITY,
      ),
    ).toBe(true);
    expect(
      serverHasCapability(
        { current: "0.7.0" },
        GIT_INCOMING_COMMITS_CAPABILITY,
      ),
    ).toBe(false);
    expect(CAPABILITY_ID_ALLOCATIONS.gitIncomingCommits.id).toBe(39);
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

  it("assigns inclusive To HEAD to permanent capability ID 40", () => {
    expect(CAPABILITY_ID_ALLOCATIONS.gitInclusiveToHead.id).toBe(40);
    const advertisement = encodeVersionedServerCapabilities(
      [GIT_INCLUSIVE_TO_HEAD_CAPABILITY],
      "0.7.0-741-gabcdef",
    );
    expect(advertisement).toEqual({
      capabilityEncoding: CAPABILITY_ID_ENCODING_VERSION,
      capabilityBits: [[1, 2 ** 8]],
    });
  });

  it("assigns Working Tree sections to permanent capability ID 41", () => {
    expect(CAPABILITY_ID_ALLOCATIONS.gitWorkingTreeSections.id).toBe(41);
    const advertisement = encodeVersionedServerCapabilities(
      [GIT_WORKING_TREE_SECTIONS_CAPABILITY],
      "0.7.0-741-gabcdef",
    );
    expect(advertisement).toEqual({
      capabilityEncoding: CAPABILITY_ID_ENCODING_VERSION,
      capabilityBits: [[1, 2 ** 9]],
    });
  });

  it("assigns complete Working Tree scans to permanent capability ID 42", () => {
    expect(CAPABILITY_ID_ALLOCATIONS.gitWorkingTreeCompleteScan.id).toBe(42);
    const advertisement = encodeVersionedServerCapabilities(
      [GIT_WORKING_TREE_COMPLETE_SCAN_CAPABILITY],
      "0.7.0-741-gabcdef",
    );
    expect(advertisement).toEqual({
      capabilityEncoding: CAPABILITY_ID_ENCODING_VERSION,
      capabilityBits: [[1, 2 ** 10]],
    });
  });

  it("assigns file revision metadata to permanent capability ID 47", () => {
    expect(CAPABILITY_ID_ALLOCATIONS.gitFileRevision.id).toBe(47);
    expect(
      serverHasCapability({ current: "0.7.2" }, GIT_FILE_REVISION_CAPABILITY),
    ).toBe(true);
    expect(
      serverHasCapability({ current: "0.7.1" }, GIT_FILE_REVISION_CAPABILITY),
    ).toBe(false);
  });

  it("assigns Codex stream/durable identity to permanent capability ID 48", () => {
    expect(CAPABILITY_ID_ALLOCATIONS.codexStreamDurableIdAlignment.id).toBe(48);
    expect(
      serverHasCapability(
        { current: "0.7.2" },
        CODEX_STREAM_DURABLE_ID_ALIGNMENT_CAPABILITY,
      ),
    ).toBe(true);
    expect(
      serverHasCapability(
        { current: "0.7.1" },
        CODEX_STREAM_DURABLE_ID_ALIGNMENT_CAPABILITY,
      ),
    ).toBe(false);

    const sourceAdvertisement = encodeVersionedServerCapabilities(
      [CODEX_STREAM_DURABLE_ID_ALIGNMENT_CAPABILITY],
      "0.7.0-741-gabcdef",
    );
    expect(sourceAdvertisement).toEqual({
      capabilityEncoding: CAPABILITY_ID_ENCODING_VERSION,
      capabilityBits: [[1, 2 ** 16]],
    });
    expect(
      serverHasCapability(
        { current: "0.7.0-741-gabcdef", ...sourceAdvertisement },
        CODEX_STREAM_DURABLE_ID_ALIGNMENT_CAPABILITY,
      ),
    ).toBe(true);
  });

  it("assigns cache-billing ignore-after to permanent capability ID 43", () => {
    expect(CAPABILITY_ID_ALLOCATIONS.cacheMissBillingIgnoreAfter.id).toBe(43);
    const advertisement = encodeVersionedServerCapabilities(
      [CACHE_MISS_BILLING_IGNORE_AFTER_CAPABILITY],
      "0.7.0-741-gabcdef",
    );
    expect(advertisement).toEqual({
      capabilityEncoding: CAPABILITY_ID_ENCODING_VERSION,
      capabilityBits: [[1, 2 ** 11]],
    });
  });

  it("assigns expected cache expiry to permanent capability ID 49", () => {
    expect(CAPABILITY_ID_ALLOCATIONS.cacheMissBillingExpectedExpiry.id).toBe(
      49,
    );
    expect(
      serverHasCapability(
        { current: "0.7.2" },
        CACHE_MISS_BILLING_EXPECTED_EXPIRY_CAPABILITY,
      ),
    ).toBe(true);
    expect(
      serverHasCapability(
        { current: "0.7.1" },
        CACHE_MISS_BILLING_EXPECTED_EXPIRY_CAPABILITY,
      ),
    ).toBe(false);
  });

  it("assigns the live worktree setting to permanent capability ID 44", () => {
    expect(CAPABILITY_ID_ALLOCATIONS.gitLiveWorktreeSetting.id).toBe(44);
    const advertisement = encodeVersionedServerCapabilities(
      [GIT_LIVE_WORKTREE_SETTING_CAPABILITY],
      "0.7.0-741-gabcdef",
    );
    expect(advertisement).toEqual({
      capabilityEncoding: CAPABILITY_ID_ENCODING_VERSION,
      capabilityBits: [[1, 2 ** 12]],
    });
  });

  it("does not infer optional live worktree protocols from the release", () => {
    expect(
      serverHasCapability(
        { current: "0.7.2" },
        GIT_WORKING_TREE_SECTIONS_CAPABILITY,
      ),
    ).toBe(false);
    expect(
      serverHasCapability(
        { current: "0.7.2" },
        GIT_WORKING_TREE_COMPLETE_SCAN_CAPABILITY,
      ),
    ).toBe(false);
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

  it("encodes the source-ahead Codex setting in the second capability word", () => {
    const advertisement = encodeVersionedServerCapabilities(
      [CODEX_REASONING_SUMMARY_SETTING_CAPABILITY],
      "0.7.0-741-gabcdef",
    );

    expect(advertisement).toEqual({
      capabilityEncoding: CAPABILITY_ID_ENCODING_VERSION,
      capabilityBits: [[1, 8]],
    });
    expect(
      serverHasCapability(
        { current: "0.7.0-741-gabcdef", ...advertisement },
        CODEX_REASONING_SUMMARY_SETTING_CAPABILITY,
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
