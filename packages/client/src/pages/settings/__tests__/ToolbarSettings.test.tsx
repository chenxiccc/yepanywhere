// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PROJECT_QUEUE_CAPABILITY,
  PROJECT_QUEUE_NEW_SESSION_SHORTCUT_SETTING_CAPABILITY,
} from "../../../lib/projectQueueVisibility";
import { ToolbarSettings } from "../ToolbarSettings";

const state = vi.hoisted(() => {
  const defaultPresence = {
    modeSelector: "first",
    steerNow: "pin",
    attachments: "first",
    slashMenu: "mid",
    thinkingToggle: "mid",
    renderMode: "hidden",
    microphone: "pin",
    waveform: "pin",
    shortcutsHelp: "last",
    contextUsage: "pin",
    btw: "hidden",
    nudge: "hidden",
    sessionStatus: "pin",
    projectQueue: "pin",
    projectQueueNewSessionShortcut: "hidden",
    composerRecall: "hidden",
  };
  return {
    defaultPresence,
    version: { capabilities: [] as string[] },
    presence: { ...defaultPresence },
  };
});

vi.mock("../../../components/SessionToolbarPreview", () => ({
  SessionToolbarPreview: () => <div data-testid="toolbar-preview" />,
  ToolbarControlPreview: ({
    activationLabel,
    controlKey,
    onActivate,
  }: {
    activationLabel?: string;
    controlKey: string;
    onActivate?: () => void;
  }) => (
    <button
      type="button"
      data-testid={`toolbar-control-preview-${controlKey}`}
      aria-label={activationLabel}
      onClick={onActivate}
    >
      {controlKey}
    </button>
  ),
}));

vi.mock("../../../hooks/useSessionToolbarPresence", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  return {
    useSessionToolbarPresence: () => {
      const [, forceRender] = React.useState(0);
      return {
        presence: state.presence,
        setControlPresence: (
          key: keyof typeof state.presence,
          value: string,
        ) => {
          state.presence = { ...state.presence, [key]: value };
          forceRender((count) => count + 1);
        },
        resetPresence: () => {
          state.presence = { ...state.defaultPresence };
          forceRender((count) => count + 1);
        },
      };
    },
  };
});

vi.mock("../../../hooks/useServerSettings", () => ({
  useServerSettings: () => ({
    settings: { clientDefaults: {} },
    error: null,
    updateSettings: vi.fn(async () => ({ settings: {} })),
  }),
}));

vi.mock("../../../hooks/useVersion", () => ({
  useVersion: () => ({
    version: state.version,
  }),
}));

vi.mock("../../../i18n", () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, string>) =>
      (
        ({
          appearanceToolbarHiddenHeading: "Hidden",
          appearanceToolbarHiddenDescription: "Off controls",
          appearanceToolbarShownHeading: "Shown",
          appearanceToolbarShownDescription: "On controls",
          appearanceToolbarSideLeft: "Left side",
          appearanceToolbarSideRight: "Right side",
          appearanceToolbarSideNoneHidden: "None hidden",
          appearanceToolbarModeTitle: "Mode Selector",
          appearanceToolbarModeDescription: "Show the permission mode selector",
          appearanceToolbarAttachmentsTitle: "Attachments",
          appearanceToolbarAttachmentsDescription: "Attach files",
          appearanceToolbarSlashTitle: "Slash Menu",
          appearanceToolbarSlashDescription: "Show slash commands",
          appearanceToolbarThinkingTitle: "Thinking Toggle",
          appearanceToolbarThinkingDescription: "Show thinking controls",
          appearanceToolbarRenderModeTitle: "Render Mode",
          appearanceToolbarRenderModeDescription: "Show rendered/source toggle",
          appearanceToolbarMicrophoneTitle: "Microphone",
          appearanceToolbarMicrophoneDescription: "Show microphone",
          appearanceToolbarWaveformTitle: "Live Microphone Waveform",
          appearanceToolbarWaveformDescription: "Show waveform",
          appearanceToolbarShortcutsTitle: "Shortcuts Help",
          appearanceToolbarShortcutsDescription: "Show shortcuts",
          appearanceToolbarContextTitle: "Context Usage",
          appearanceToolbarContextDescription: "Show context usage",
          appearanceToolbarBtwTitle: "/btw Button",
          appearanceToolbarBtwDescription: "Show /btw",
          appearanceToolbarNudgeTitle: "Heartbeat/Nudge Button",
          appearanceToolbarNudgeDescription: "Show nudge",
          appearanceToolbarStatusTitle: "Session Status",
          appearanceToolbarStatusDescription: "Show status",
          appearanceToolbarSteerNowTitle: '"Now" steering selector',
          appearanceToolbarSteerNowDescription: "Show now selector",
          appearanceToolbarProjectQueueTitle: "Project Queue",
          appearanceToolbarProjectQueueDescription:
            "Send after all sessions in this project are idle",
          appearanceToolbarProjectQueueNewSessionShortcutTitle:
            "Queue as New Session Shortcut",
          appearanceToolbarProjectQueueNewSessionShortcutDescription:
            "Queue a separate session from an existing composer",
          appearanceToolbarComposerRecallTitle: "Message recall button",
          appearanceToolbarComposerRecallDescription:
            "Open the earlier-message recall list",
          appearanceSessionToolbarDescription: "Toolbar controls",
          appearanceToolbarDefaultActionTitle: "Default action",
          appearanceToolbarDefaultActionDescription: "Choose an action",
          appearanceToolbarDefaultActionSteer: "Steer",
          appearanceToolbarDefaultActionQueue: "Queue",
          appearanceToolbarCollapsedButtonTitle: "Collapsed button",
          appearanceToolbarCollapsedButtonDescription: "Choose a button",
          appearanceToolbarCollapsedButtonPrimary: "Primary",
          appearanceToolbarCollapsedButtonAlternate: "Alternate",
          appearanceToolbarCollapsedButtonMicrophone: "Microphone",
          appearanceToolbarPresenceAria: `${params?.control} visibility`,
          appearanceToolbarPresenceHiddenCaption: "Not shown on the toolbar.",
          appearanceToolbarPresenceFirstCaption: "Collapses first",
          appearanceToolbarPresenceMidCaption: "Collapses in the middle",
          appearanceToolbarPresenceLastCaption: "Collapses last",
          appearanceToolbarPresencePinCaption: "Never collapses",
          appearanceToolbarPresenceShownCaption: "Always visible",
          appearanceToolbarActivateControl: `Edit ${params?.control}`,
          appearanceSessionToolbarReset: "Reset",
          appearanceToolbarHide: "Hide",
          appearanceToolbarShowAlways: "Show always",
        }) as Record<string, string>
      )[key] ?? key,
  }),
}));

vi.mock("../SettingsPaneTitleContext", () => ({
  useSettingsPaneTitle: vi.fn(),
}));

vi.mock("../SettingsUndoContext", () => ({
  useSettingsUndoBaseline: vi.fn(),
}));

describe("ToolbarSettings", () => {
  beforeEach(() => {
    state.version = { capabilities: [] };
    state.presence = { ...state.defaultPresence };
  });

  afterEach(() => {
    cleanup();
  });

  it("hides the Project Queue option without server capability", () => {
    render(<ToolbarSettings />);

    expect(screen.queryByText("Project Queue")).toBe(null);
    expect(screen.queryByText("Queue as New Session Shortcut")).toBe(null);
  });

  it("shows only the current-session control without shortcut capability", () => {
    state.version = { capabilities: [PROJECT_QUEUE_CAPABILITY] };

    render(<ToolbarSettings />);

    expect(screen.getByText("Project Queue")).toBeTruthy();
    expect(screen.queryByText("Queue as New Session Shortcut")).toBe(null);
  });

  it("shows the shortcut control hidden when its capability is present", () => {
    state.version = {
      capabilities: [
        PROJECT_QUEUE_CAPABILITY,
        PROJECT_QUEUE_NEW_SESSION_SHORTCUT_SETTING_CAPABILITY,
      ],
    };

    render(<ToolbarSettings />);

    const shortcutRow = screen
      .getByText("Queue as New Session Shortcut")
      .closest(".session-toolbar-control-row");
    expect(shortcutRow).toBeTruthy();
    expect(
      within(shortcutRow as HTMLElement).getByRole<HTMLInputElement>("slider", {
        name: "Queue as New Session Shortcut visibility",
      }).value,
    ).toBe("0");
  });

  it("ships the message recall button hidden, with only Hide / Show always", () => {
    render(<ToolbarSettings />);

    const row = screen
      .getByText("Message recall button")
      .closest(".session-toolbar-control-row");
    expect(row).toBeTruthy();
    const slider = within(row as HTMLElement).getByRole<HTMLInputElement>(
      "slider",
      { name: "Message recall button visibility" },
    );
    expect(slider.value).toBe("0");
    // Keyboard-row only, so it never enters the toolbar overflow engine.
    expect(slider.getAttribute("max")).toBe("1");
  });

  it("shows a presence slider for every control row", () => {
    render(<ToolbarSettings />);

    // 14 controls without the projectQueue capability, one slider each.
    expect(screen.getAllByRole("slider")).toHaveLength(14);
    // Overflow-supported controls get the full notch scale...
    expect(
      screen
        .getByRole("slider", { name: "Mode Selector visibility" })
        .getAttribute("max"),
    ).toBe("4");
    // ...while non-overflow controls only get Hide / Show always.
    expect(
      screen
        .getByRole("slider", { name: "Microphone visibility" })
        .getAttribute("max"),
    ).toBe("1");
  });

  it("keeps hidden overflow controls priority-editable", () => {
    render(<ToolbarSettings />);

    const row = screen
      .getByText("Render Mode")
      .closest(".session-toolbar-control-row");
    expect(row).toBeTruthy();
    const slider = within(row as HTMLElement).getByRole<HTMLInputElement>(
      "slider",
      { name: "Render Mode visibility" },
    );
    expect(slider.getAttribute("max")).toBe("4");
    expect(slider.value).toBe("0");

    fireEvent.change(slider, { target: { value: "3" } });
    fireEvent.pointerUp(slider);

    expect(state.presence.renderMode).toBe("last");
  });

  it("focuses the row slider from the specimen affordance", () => {
    render(<ToolbarSettings />);

    fireEvent.click(screen.getByTestId("toolbar-control-preview-modeSelector"));

    expect(document.activeElement).toBe(
      screen.getByRole("slider", { name: "Mode Selector visibility" }),
    );
  });

  it("keeps rows in their entry section after visibility changes", () => {
    render(<ToolbarSettings />);

    const shownZone = screen
      .getByText("Shown")
      .closest(".session-toolbar-zone");
    const hiddenZone = screen
      .getByText("Hidden")
      .closest(".session-toolbar-zone");
    expect(shownZone).toBeTruthy();
    expect(hiddenZone).toBeTruthy();

    const modeRow = within(shownZone as HTMLElement)
      .getByText("Mode Selector")
      .closest(".session-toolbar-control-row");
    expect(modeRow).toBeTruthy();

    const slider = within(modeRow as HTMLElement).getByRole<HTMLInputElement>(
      "slider",
      { name: "Mode Selector visibility" },
    );
    fireEvent.change(slider, { target: { value: "0" } });
    fireEvent.pointerUp(slider);

    expect(state.presence.modeSelector).toBe("hidden");
    expect(
      within(shownZone as HTMLElement).getByText("Mode Selector"),
    ).toBeTruthy();
    expect(
      within(hiddenZone as HTMLElement).queryByText("Mode Selector"),
    ).toBeNull();
  });

  it("hiding forgets the tier; sliding back out picks the landed notch", () => {
    render(<ToolbarSettings />);

    const slider = screen.getByRole<HTMLInputElement>("slider", {
      name: "Slash Menu visibility",
    });
    expect(slider.value).toBe("2");

    fireEvent.change(slider, { target: { value: "0" } });
    fireEvent.pointerUp(slider);
    expect(state.presence.slashMenu).toBe("hidden");

    fireEvent.change(slider, { target: { value: "4" } });
    fireEvent.pointerUp(slider);
    expect(state.presence.slashMenu).toBe("pin");
  });
});
