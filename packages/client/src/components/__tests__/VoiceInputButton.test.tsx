// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { VOICE_INPUT_CAPABILITY } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UseSpeechRecognitionOptions } from "../../hooks/useSpeechRecognition";
import { VoiceInputButton } from "../VoiceInputButton";

const {
  observedSpeechOptions,
  openSpeechSocket,
  sourceTransport,
  speechState,
  versionState,
} = vi.hoisted(() => {
  const openSpeechSocket = vi.fn();
  return {
    observedSpeechOptions: [] as UseSpeechRecognitionOptions[],
    openSpeechSocket,
    sourceTransport: {
      capabilities: {
        sameOriginUrls: false,
        speech: { open: openSpeechSocket },
      },
    },
    speechState: {
      isListening: false,
      status: "idle" as
        | "idle"
        | "starting"
        | "listening"
        | "receiving"
        | "processing"
        | "finalizing"
        | "reconnecting"
        | "error",
    },
    versionState: {
      capabilities: [] as string[],
    },
  };
});

vi.mock("../../contexts/SourceRuntimeContext", () => ({
  useCurrentSourceRuntime: () => ({
    transport: sourceTransport,
  }),
}));

vi.mock("../../hooks/useModelSettings", () => ({
  useModelSettings: () => ({
    voiceInputEnabled: true,
    speechMethod: "browser-native",
    hasStoredSpeechMethod: false,
    parakeetSpeechModel: "nvidia/parakeet-ctc-1.1b",
    grokSpeechAudioSettings: { uplinkMode: "pcm16" },
  }),
}));

vi.mock("../../hooks/useRemoteBasePath", () => ({
  useRemoteBasePath: () => "/ygraehl",
}));

vi.mock("../../hooks/useSpeechCaptureSettings", () => ({
  useSpeechCaptureSettings: () => ({
    keepMicWarm: false,
    micDeviceId: null,
  }),
}));

vi.mock("../../hooks/useSpeechRecognition", () => ({
  useSpeechRecognition: (options: UseSpeechRecognitionOptions) => {
    observedSpeechOptions.push(options);
    return {
      isSupported: true,
      isListening: speechState.isListening,
      status: speechState.status,
      interimTranscript: "",
      startListening: vi.fn(),
      stopListening: vi.fn(),
      toggleListening: vi.fn(),
      prewarm: vi.fn(),
      error: null,
    };
  },
}));

vi.mock("../../hooks/useVersion", () => ({
  useVersion: () => ({
    version: {
      capabilities: versionState.capabilities,
      voiceBackends: [],
      voiceBackendCapabilities: {},
    },
  }),
}));

vi.mock("../../hooks/useViewportWidth", () => ({
  useViewportWidth: () => 800,
}));

vi.mock("../../i18n", () => ({
  useI18n: () => ({
    t: (key: string) =>
      ({
        speechReadyStatus: "Ready",
        speechStartingStatus: "Starting...",
        speechSpeakNowStatus: "Speak now...",
        speechListeningPlaceholder: "Listening...",
        speechTranscribingPlaceholder: "Transcribing...",
        speechFinalizingPlaceholder: "Finalizing...",
        speechErrorStatus: "Error",
      })[key] ?? key,
  }),
}));

vi.mock("../../lib/deviceDetection", () => ({
  hasCoarsePointer: () => false,
}));

describe("VoiceInputButton", () => {
  beforeEach(() => {
    versionState.capabilities = [VOICE_INPUT_CAPABILITY];
  });

  afterEach(() => {
    cleanup();
    observedSpeechOptions.length = 0;
    openSpeechSocket.mockReset();
    speechState.isListening = false;
    speechState.status = "idle";
  });

  it("keeps the relayed speech socket opener stable across rerenders", () => {
    const props = {
      onTranscript: vi.fn(),
      onInterimTranscript: vi.fn(),
      speechMethod: "browser-native",
    };

    const { rerender } = render(<VoiceInputButton {...props} />);
    const firstOpenSpeechSocket =
      observedSpeechOptions.at(-1)?.openRelayedSpeechSocket;

    rerender(<VoiceInputButton {...props} />);
    const secondOpenSpeechSocket =
      observedSpeechOptions.at(-1)?.openRelayedSpeechSocket;

    expect(firstOpenSpeechSocket).toBeDefined();
    expect(secondOpenSpeechSocket).toBe(firstOpenSpeechSocket);
  });

  it("does not render post-capture processing as active capture", () => {
    speechState.status = "processing";

    render(
      <VoiceInputButton
        onTranscript={vi.fn()}
        onInterimTranscript={vi.fn()}
        speechMethod="browser-native"
      />,
    );

    const button = screen.getByRole("button", { name: "voiceInputStartLabel" });
    expect(button.className).not.toContain("listening");
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(document.querySelector(".voice-input-recording")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("Transcribing...");
  });

  it("passes the browser-selected Parakeet model to speech providers", () => {
    render(
      <VoiceInputButton
        onTranscript={vi.fn()}
        onInterimTranscript={vi.fn()}
        speechMethod="ya-parakeet"
      />,
    );

    expect(observedSpeechOptions.at(-1)?.parakeetModel).toBe(
      "nvidia/parakeet-ctc-1.1b",
    );
  });

  it("does not render streaming finalization as active capture", () => {
    speechState.status = "finalizing";

    render(
      <VoiceInputButton
        onTranscript={vi.fn()}
        onInterimTranscript={vi.fn()}
        speechMethod="browser-native"
      />,
    );

    const button = screen.getByRole("button", { name: "Finalizing..." });
    expect(button.className).not.toContain("listening");
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(document.querySelector(".voice-input-recording")).toBeNull();
  });

  it("reports a listening pending kind during active capture", () => {
    speechState.status = "listening";
    speechState.isListening = true;
    const onPendingSpeechChange = vi.fn();

    render(
      <VoiceInputButton
        onTranscript={vi.fn()}
        onInterimTranscript={vi.fn()}
        onPendingSpeechChange={onPendingSpeechChange}
        speechMethod="browser-native"
      />,
    );

    // The composer surfaces capture as a cancellable chip too, so the ✕ can
    // abandon the in-flight utterance — not just the post-capture waits.
    expect(onPendingSpeechChange).toHaveBeenCalledWith("listening");
  });

  it("suppresses redundant listening text when a live waveform is available", () => {
    speechState.status = "listening";
    speechState.isListening = true;

    render(
      <VoiceInputButton
        onTranscript={vi.fn()}
        onInterimTranscript={vi.fn()}
        speechMethod="ya-parakeet"
        showWaveform
      />,
    );

    expect(document.querySelector(".voice-input-status")).toBeNull();
    const recordingIcon = document.querySelector(".voice-input-recording");
    expect(recordingIcon).toBeTruthy();
    expect(recordingIcon?.classList.contains("is-speech-active")).toBe(false);
  });

  it("prompts when browser-native capture is ready without sample access", () => {
    speechState.status = "listening";
    speechState.isListening = true;

    render(
      <VoiceInputButton
        onTranscript={vi.fn()}
        onInterimTranscript={vi.fn()}
        speechMethod="browser-native"
        showWaveform
      />,
    );

    expect(document.querySelector(".voice-input-status")?.textContent).toBe(
      "Speak now...",
    );
  });

  it("shows listening while browser-native speech is active", () => {
    speechState.status = "receiving";
    speechState.isListening = true;

    render(
      <VoiceInputButton
        onTranscript={vi.fn()}
        onInterimTranscript={vi.fn()}
        speechMethod="browser-native"
      />,
    );

    expect(screen.getByRole("status").textContent).toBe("Listening...");
    expect(
      document
        .querySelector(".voice-input-recording")
        ?.classList.contains("is-speech-active"),
    ).toBe(true);
  });

  it("describes an automatic recognizer restart as starting", () => {
    speechState.status = "reconnecting";

    render(
      <VoiceInputButton
        onTranscript={vi.fn()}
        onInterimTranscript={vi.fn()}
        speechMethod="browser-native"
      />,
    );

    expect(screen.getByRole("status").textContent).toBe("Starting...");
  });

  it("keeps the microphone neutral while capture starts", () => {
    speechState.status = "starting";

    render(
      <VoiceInputButton
        onTranscript={vi.fn()}
        onInterimTranscript={vi.fn()}
        speechMethod="browser-native"
      />,
    );

    const button = screen.getByRole("button", { name: "voiceInputStopLabel" });
    expect(button.classList.contains("connecting")).toBe(false);
    expect(button.classList.contains("listening")).toBe(false);
    expect(document.querySelector(".voice-input-recording")).toBeNull();
  });
});
