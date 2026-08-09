// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { VOICE_INPUT_CAPABILITY } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SpeechSettings } from "../SpeechSettings";

const modelSettings = vi.hoisted(() => {
  const state = {
    voiceInputEnabled: true,
    setVoiceInputEnabled: vi.fn(),
    speechMethod: "ya-parakeet",
    hasStoredSpeechMethod: true,
    setSpeechMethod: vi.fn(),
    speechSmartTurnSettings: {
      enabled: false,
      threshold: 0.5,
      timeoutMs: 2000,
    },
    setSpeechSmartTurnSettings: vi.fn(),
    parakeetSpeechModel: "nvidia/parakeet-tdt-0.6b-v3",
    setParakeetSpeechModel: vi.fn(),
  };
  state.setSpeechMethod = vi.fn((method: string) => {
    state.speechMethod = method;
  });
  state.setParakeetSpeechModel = vi.fn((model: string) => {
    state.parakeetSpeechModel = model;
  });
  return state;
});
const speechCaptureSettings = vi.hoisted(() => ({
  keepMicWarm: false,
  setKeepMicWarm: vi.fn(),
  reducePlayback: true,
  setReducePlayback: vi.fn(),
  unspokenPunctuation: false,
  setUnspokenPunctuation: vi.fn(),
  followUpListenMs: 0,
  setFollowUpListenMs: vi.fn(),
  asrAttributionMs: 0,
  setAsrAttributionMs: vi.fn(),
  speechMessagePrefixMode: "off" as const,
  setSpeechMessagePrefixMode: vi.fn(),
  speechMessageCustomPrefix: "",
  setSpeechMessageCustomPrefix: vi.fn(),
  speechMessagePrefix: null,
}));
const browserXaiKey = vi.hoisted(() => ({
  browserXaiSttApiKey: "",
  hasBrowserXaiSttApiKey: false,
  setBrowserXaiSttApiKey: vi.fn(),
}));
const speechSourceRuntime = vi.hoisted(() => ({
  relayTransport: false,
  relayedServerSpeechAvailable: false,
}));
const versionState = vi.hoisted(() => ({
  capabilities: [] as string[],
  voiceBackends: ["ya-grok", "ya-parakeet", "ya-nemo"],
  voiceBackendStatuses: [] as Array<{
    id: string;
    label: string;
    enabled: boolean;
    validationStatus: "pending" | "enabled" | "disabled";
    disabledReason?: string;
  }>,
}));
const prewarmYaServerSpeechBackend = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("../../../hooks/useModelSettings", () => ({
  useModelSettings: () => modelSettings,
}));

vi.mock("../../../hooks/useSpeechCaptureSettings", () => ({
  MAX_SPEECH_FOLLOW_UP_LISTEN_MS: 30_000,
  MAX_SPEECH_ASR_ATTRIBUTION_MS: 5_000,
  MAX_SPEECH_MESSAGE_CUSTOM_PREFIX_LENGTH: 64,
  useSpeechCaptureSettings: () => speechCaptureSettings,
}));

vi.mock("../../../hooks/useBrowserXaiSttApiKey", () => ({
  useBrowserXaiSttApiKey: () => browserXaiKey,
}));

vi.mock("../../../hooks/useSpeechSourceRuntime", () => ({
  useSpeechSourceRuntime: () => speechSourceRuntime,
}));

vi.mock("../../../hooks/useVersion", () => ({
  useVersion: () => ({
    version: {
      capabilities: versionState.capabilities,
      voiceBackends: versionState.voiceBackends,
      voiceBackendStatuses: versionState.voiceBackendStatuses,
      voiceBackendCapabilities: {
        "ya-grok": { streaming: true, smartTurn: true },
      },
    },
    loading: false,
  }),
}));

vi.mock("../../../i18n", () => ({
  useI18n: () => ({
    t: (key: string, values?: Record<string, string>) =>
      values?.backend
        ? `${key} ${values.backend}`
        : values?.label
          ? `${key} ${values.label}`
          : key,
  }),
}));

vi.mock("../../../lib/speechProviders/YaServerProvider", () => ({
  prewarmYaServerSpeechBackend,
}));

describe("SpeechSettings", () => {
  beforeEach(() => {
    versionState.capabilities = [VOICE_INPUT_CAPABILITY];
  });

  afterEach(() => {
    cleanup();
    modelSettings.speechMethod = "ya-parakeet";
    modelSettings.parakeetSpeechModel = "nvidia/parakeet-tdt-0.6b-v3";
    versionState.voiceBackends = ["ya-grok", "ya-parakeet", "ya-nemo"];
    versionState.voiceBackendStatuses = [];
    speechSourceRuntime.relayTransport = false;
    speechSourceRuntime.relayedServerSpeechAvailable = false;
    modelSettings.setSpeechMethod.mockClear();
    modelSettings.setParakeetSpeechModel.mockClear();
    speechCaptureSettings.setKeepMicWarm.mockClear();
    speechCaptureSettings.setReducePlayback.mockClear();
    speechCaptureSettings.unspokenPunctuation = false;
    speechCaptureSettings.setUnspokenPunctuation.mockClear();
    speechCaptureSettings.setFollowUpListenMs.mockClear();
    speechCaptureSettings.setAsrAttributionMs.mockClear();
    speechCaptureSettings.setSpeechMessagePrefixMode.mockClear();
    speechCaptureSettings.setSpeechMessageCustomPrefix.mockClear();
    browserXaiKey.setBrowserXaiSttApiKey.mockClear();
    prewarmYaServerSpeechBackend.mockClear();
  });

  it("prewarms a Parakeet preset selected in global STT options", () => {
    render(<SpeechSettings />);

    fireEvent.change(
      screen.getByLabelText("speechSettingsParakeetModelPresetLabel"),
      {
        target: { value: "nvidia/parakeet-ctc-1.1b" },
      },
    );

    expect(modelSettings.setParakeetSpeechModel).toHaveBeenCalledWith(
      "nvidia/parakeet-ctc-1.1b",
    );
    expect(prewarmYaServerSpeechBackend).toHaveBeenCalledWith(
      "ya-parakeet",
      "nvidia/parakeet-ctc-1.1b",
    );
  });

  it("offers the default-off speech prefix selector", () => {
    render(<SpeechSettings />);

    const selector = screen.getByLabelText("speechSettingsMessagePrefixTitle");
    expect((selector as HTMLSelectElement).value).toBe("off");
    fireEvent.change(selector, { target: { value: "stt" } });
    expect(
      speechCaptureSettings.setSpeechMessagePrefixMode,
    ).toHaveBeenCalledWith("stt");
  });

  it("offers default-off browser punctuation as an explicit opt-in", () => {
    render(<SpeechSettings />);

    const toggle = screen.getByRole("checkbox", {
      name: "speechSettingsUnspokenPunctuationTitle",
    }) as HTMLInputElement;
    expect(toggle.checked).toBe(false);

    fireEvent.click(toggle);

    expect(speechCaptureSettings.setUnspokenPunctuation).toHaveBeenCalledWith(
      true,
    );
  });

  it("shows a validating backend immediately but does not allow selection", () => {
    versionState.voiceBackends = ["ya-grok"];
    versionState.voiceBackendStatuses = [
      {
        id: "ya-grok",
        label: "Grok",
        enabled: true,
        validationStatus: "enabled",
      },
      {
        id: "ya-nemo",
        label: "NeMo",
        enabled: false,
        validationStatus: "pending",
      },
    ];
    render(<SpeechSettings />);

    fireEvent.click(
      screen.getByRole("button", {
        name: "filterByLabel speechSettingsBackendTitle",
      }),
    );

    const option = screen.getByRole("button", {
      name: /NeMo Parakeet STT speechSettingsBackendValidating/,
    }) as HTMLButtonElement;
    expect(option.disabled).toBe(true);
  });

  it("switches to a compatible enabled backend for a selected Parakeet preset", () => {
    render(<SpeechSettings />);

    fireEvent.change(
      screen.getByLabelText("speechSettingsParakeetModelPresetLabel"),
      {
        target: { value: "nvidia/parakeet-rnnt-1.1b" },
      },
    );

    expect(modelSettings.setParakeetSpeechModel).toHaveBeenCalledWith(
      "nvidia/parakeet-rnnt-1.1b",
    );
    expect(modelSettings.setSpeechMethod).toHaveBeenCalledWith("ya-nemo");
    expect(prewarmYaServerSpeechBackend).toHaveBeenCalledWith(
      "ya-nemo",
      "nvidia/parakeet-rnnt-1.1b",
    );
  });

  it("disables Parakeet presets unsupported by enabled local backends", () => {
    versionState.voiceBackends = ["ya-grok", "ya-parakeet"];

    render(<SpeechSettings />);

    const option = screen.getByRole("option", {
      name: /RNNT 1\.1B English lowercase/,
    }) as HTMLOptionElement;

    expect(option.disabled).toBe(true);
    expect(option.textContent).toContain("NeMo Parakeet");
  });

  it("prewarms the current Parakeet model when selecting a local STT backend globally", () => {
    modelSettings.speechMethod = "ya-grok";
    render(<SpeechSettings />);

    fireEvent.click(
      screen.getByRole("button", {
        name: "filterByLabel speechSettingsBackendTitle",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: /NeMo Parakeet STT/ }));

    expect(modelSettings.setSpeechMethod).toHaveBeenCalledWith("ya-nemo");
    expect(prewarmYaServerSpeechBackend).toHaveBeenCalledWith(
      "ya-nemo",
      "nvidia/parakeet-tdt-0.6b-v3",
    );
  });

  it("normalizes an incompatible preset when selecting a local STT backend globally", () => {
    modelSettings.speechMethod = "ya-grok";
    modelSettings.parakeetSpeechModel = "nvidia/parakeet-rnnt-1.1b";
    render(<SpeechSettings />);

    fireEvent.click(
      screen.getByRole("button", {
        name: "filterByLabel speechSettingsBackendTitle",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: /^Parakeet STT/ }));

    expect(modelSettings.setSpeechMethod).toHaveBeenCalledWith("ya-parakeet");
    expect(modelSettings.setParakeetSpeechModel).toHaveBeenCalledWith(
      "nvidia/parakeet-tdt-0.6b-v3",
    );
    expect(prewarmYaServerSpeechBackend).toHaveBeenCalledWith(
      "ya-parakeet",
      "nvidia/parakeet-tdt-0.6b-v3",
    );
  });

  it("shows a missing explicit backend as unavailable without switching", () => {
    modelSettings.speechMethod = "ya-deepgram";
    versionState.voiceBackends = ["ya-grok"];

    render(<SpeechSettings />);

    expect(screen.getByText("speechSettingsBackendUnavailable")).toBeTruthy();
    expect(modelSettings.setSpeechMethod).not.toHaveBeenCalled();
  });

  it("uses the current relayed source speech channel for Smart Turn", () => {
    modelSettings.speechMethod = "ya-grok";
    speechSourceRuntime.relayTransport = true;
    speechSourceRuntime.relayedServerSpeechAvailable = true;

    render(<SpeechSettings />);

    expect(screen.getByRole("checkbox", { name: "Smart Turn" })).toBeTruthy();
    expect(
      screen.queryByText("speechSettingsStreamingRelayUnavailable"),
    ).toBeNull();
  });

  it("reports relayed streaming unavailable without a speech channel", () => {
    modelSettings.speechMethod = "ya-grok";
    speechSourceRuntime.relayTransport = true;
    speechSourceRuntime.relayedServerSpeechAvailable = false;

    render(<SpeechSettings />);

    expect(screen.queryByRole("checkbox", { name: "Smart Turn" })).toBeNull();
    expect(
      screen.getAllByText("speechSettingsStreamingRelayUnavailable").length,
    ).toBeGreaterThan(0);
  });
});
