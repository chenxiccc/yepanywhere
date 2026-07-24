// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BANG_COMMANDS_CAPABILITY,
  DEFAULT_PROJECT_QUEUE_QUIET_SECONDS,
  PROJECT_QUEUE_CAPABILITY,
} from "@yep-anywhere/shared";
import type { ServerSettings } from "../../../api/client";
import { MessageDeliverySettings } from "../MessageDeliverySettings";
import {
  SettingsUndoProvider,
  type SettingsUndoRegistration,
} from "../SettingsUndoContext";

const { mockUpdateSettings, hookState, versionState } = vi.hoisted(() => ({
  mockUpdateSettings: vi.fn(),
  hookState: {
    settings: null as ServerSettings | null,
    isLoading: false,
    error: null as string | null,
  },
  versionState: {
    version: { capabilities: [] as string[] } as {
      capabilities?: string[];
    },
  },
}));

vi.mock("../../../hooks/useServerSettings", () => ({
  useServerSettings: () => ({
    ...hookState,
    updateSetting: vi.fn(),
    updateSettings: mockUpdateSettings,
    refetch: vi.fn(),
  }),
}));

vi.mock("../../../hooks/useVersion", () => ({
  useVersion: () => ({ version: versionState.version }),
}));

vi.mock("../../../i18n", () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}));

const baseSettings: ServerSettings = {
  serviceWorkerEnabled: true,
  persistRemoteSessionsToDisk: false,
  deferredJoinWindowSeconds: 0,
  composeAnchorsEnabled: false,
};

describe("MessageDeliverySettings", () => {
  beforeEach(() => {
    hookState.settings = { ...baseSettings };
    hookState.isLoading = false;
    hookState.error = null;
    versionState.version = { capabilities: [PROJECT_QUEUE_CAPABILITY] };
    mockUpdateSettings.mockReset();
    mockUpdateSettings.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("applies the anchors toggle immediately, with no Save button", () => {
    render(<MessageDeliverySettings />);

    expect(screen.queryByText("providersSave")).toBeNull();

    fireEvent.click(
      screen.getByLabelText("messageDeliveryComposeAnchorsTitle"),
    );
    expect(mockUpdateSettings).toHaveBeenCalledWith({
      composeAnchorsEnabled: true,
    });
  });

  it("debounce-saves the join window from the numeric input", () => {
    vi.useFakeTimers();
    render(<MessageDeliverySettings />);

    fireEvent.change(
      screen.getByRole("spinbutton", {
        name: "messageDeliveryJoinWindowTitle",
      }),
      {
        target: { value: "30" },
      },
    );
    expect(mockUpdateSettings).not.toHaveBeenCalled();

    vi.advanceTimersByTime(500);
    expect(mockUpdateSettings).toHaveBeenCalledWith({
      deferredJoinWindowSeconds: 30,
    });
  });

  it("debounce-saves the Project Queue quiet window from the numeric input", () => {
    vi.useFakeTimers();
    render(<MessageDeliverySettings />);

    fireEvent.change(
      screen.getByRole("spinbutton", {
        name: "messageDeliveryProjectQueueQuietTitle",
      }),
      {
        target: { value: "60" },
      },
    );
    expect(mockUpdateSettings).not.toHaveBeenCalled();

    vi.advanceTimersByTime(500);
    expect(mockUpdateSettings).toHaveBeenCalledWith({
      projectQueueQuietSeconds: 60,
    });
  });

  it("does not save the join-window slider until release", () => {
    vi.useFakeTimers();
    render(<MessageDeliverySettings />);

    const slider = screen.getByRole<HTMLInputElement>("slider", {
      name: "messageDeliveryJoinWindowTitle",
    });
    fireEvent.change(slider, { target: { value: "45" } });

    vi.advanceTimersByTime(500);
    expect(mockUpdateSettings).not.toHaveBeenCalled();

    fireEvent.pointerUp(slider);
    vi.advanceTimersByTime(500);

    expect(mockUpdateSettings).toHaveBeenCalledWith({
      deferredJoinWindowSeconds: 45,
    });
  });

  it("saves the busy-composer default action immediately", () => {
    render(<MessageDeliverySettings />);

    fireEvent.change(
      screen.getByLabelText("appearanceToolbarDefaultActionTitle"),
      { target: { value: "queue" } },
    );

    expect(mockUpdateSettings).toHaveBeenCalledWith({
      clientDefaults: { busyComposerDefaultAction: "queue" },
    });
  });

  it("saves the Project Queue Ctrl+Enter preference immediately", () => {
    render(<MessageDeliverySettings />);

    fireEvent.click(
      screen.getByLabelText("messageDeliveryProjectQueueShortcutTitle"),
    );

    expect(mockUpdateSettings).toHaveBeenCalledWith({
      clientDefaults: { projectQueueCtrlEnterEnabled: false },
    });
  });

  it("keeps local bang commands default-off behind a server capability", () => {
    render(<MessageDeliverySettings />);
    expect(screen.queryByLabelText("messageDeliveryBangCommandsTitle")).toBe(
      null,
    );

    cleanup();
    versionState.version = {
      capabilities: [PROJECT_QUEUE_CAPABILITY, BANG_COMMANDS_CAPABILITY],
    };
    render(<MessageDeliverySettings />);

    const toggle = screen.getByLabelText("messageDeliveryBangCommandsTitle");
    expect((toggle as HTMLInputElement).checked).toBe(false);
    fireEvent.click(toggle);
    expect(mockUpdateSettings).toHaveBeenCalledWith({
      clientDefaults: { bangCommandsEnabled: true },
    });
  });

  it("hides Project Queue-only controls without the server capability", () => {
    versionState.version = { capabilities: [] };

    render(<MessageDeliverySettings />);

    expect(
      screen.queryByLabelText("messageDeliveryProjectQueueQuietTitle"),
    ).toBe(null);
    expect(
      screen.queryByLabelText("messageDeliveryProjectQueueShortcutTitle"),
    ).toBe(null);
  });

  it("registers a header undo that reverts to the open-time snapshot", async () => {
    const holder: { registration: SettingsUndoRegistration | null } = {
      registration: null,
    };
    hookState.settings = {
      ...baseSettings,
      deferredJoinWindowSeconds: 20,
      composeAnchorsEnabled: true,
    };

    render(
      <SettingsUndoProvider
        value={(next) => {
          holder.registration = next;
        }}
      >
        <MessageDeliverySettings />
      </SettingsUndoProvider>,
    );

    // Untouched pane registers no undo.
    expect(holder.registration).toBeNull();

    fireEvent.click(
      screen.getByLabelText("messageDeliveryComposeAnchorsTitle"),
    );
    await waitFor(() => expect(holder.registration?.canUndo).toBe(true));

    // The undo callback sets component state; invoke it inside act.
    await act(async () => {
      await holder.registration?.undo();
    });
    expect(mockUpdateSettings).toHaveBeenLastCalledWith({
      deferredJoinWindowSeconds: 20,
      projectQueueQuietSeconds: DEFAULT_PROJECT_QUEUE_QUIET_SECONDS,
      composeAnchorsEnabled: true,
      clientDefaults: {
        busyComposerDefaultAction: "steer",
        steerNowDefault: false,
        patientQueueDefault: false,
        projectQueueCtrlEnterEnabled: true,
      },
    });
  });
});
