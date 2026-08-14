import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import {
  PROJECT_QUEUE_CAPABILITY,
  PROJECT_QUEUE_NEW_SESSION_SHORTCUT_SETTING_CAPABILITY,
  REMOTE_BROWSER_DIAGNOSTICS_CAPABILITY,
} from "@yep-anywhere/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLIENT_STORAGE_DEFAULT } from "../../lib/defaultedStorage";
import { UI_KEYS } from "../../lib/storageKeys";

const mocks = vi.hoisted(() => ({
  updateServerSettings: vi.fn(async () => ({ settings: {} })),
  version: null as unknown,
}));

vi.mock("../../api/client", () => ({
  api: {
    updateServerSettings: mocks.updateServerSettings,
  },
}));

vi.mock("../useVersion", () => ({
  useVersion: () => ({
    version: mocks.version,
  }),
}));

function stubToolbarLayout(matches: boolean): void {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation((query: string) => ({
      matches,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}

describe("useSessionToolbarPresence", () => {
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    mocks.version = null;
    mocks.updateServerSettings.mockClear();
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it("shows Conversation view in its approved default-on state", async () => {
    stubToolbarLayout(false);
    const { DEFAULT_SESSION_TOOLBAR_PRESENCE, useSessionToolbarPresence } =
      await import("../useSessionToolbarPresence");
    const { useConversationView } = await import("../useConversationView");

    const { result } = renderHook(() => useSessionToolbarPresence());
    const conversation = renderHook(() => useConversationView());

    expect(DEFAULT_SESSION_TOOLBAR_PRESENCE.renderMode).toBe("hidden");
    expect(result.current.presence.renderMode).toBe("hidden");
    expect(result.current.visibility.renderMode).toBe(false);
    expect(DEFAULT_SESSION_TOOLBAR_PRESENCE.conversationView).toBe("last");
    expect(result.current.presence.conversationView).toBe("last");
    expect(result.current.visibility.conversationView).toBe(true);
    expect(conversation.result.current.conversationViewEnabled).toBe(true);
    expect(DEFAULT_SESSION_TOOLBAR_PRESENCE.browserDebug).toBe("hidden");
    expect(result.current.visibility.browserDebug).toBe(false);
  });

  it("reveals browser debugging only with capability and local opt-in", async () => {
    stubToolbarLayout(false);
    mocks.version = {
      capabilities: [REMOTE_BROWSER_DIAGNOSTICS_CAPABILITY],
    };
    const { useSessionToolbarPresence } = await import(
      "../useSessionToolbarPresence"
    );
    const { result } = renderHook(() => useSessionToolbarPresence());

    for (const priority of ["first", "mid", "last", "pin"] as const) {
      act(() => result.current.setControlPresence("browserDebug", priority));
      expect(result.current.presence.browserDebug).toBe(priority);
      expect(result.current.visibility.browserDebug).toBe(true);
    }
    expect(mocks.updateServerSettings).not.toHaveBeenCalled();
  });

  it("activates Conversation view when its client-only control is enabled", async () => {
    stubToolbarLayout(false);
    window.localStorage.setItem(UI_KEYS.conversationView, "false");
    window.localStorage.setItem(
      UI_KEYS.sessionToolbarPresence,
      JSON.stringify({ conversationView: "hidden" }),
    );
    const { useSessionToolbarPresence } = await import(
      "../useSessionToolbarPresence"
    );
    const { getConversationViewPreference } = await import(
      "../useConversationView"
    );
    const { result } = renderHook(() => useSessionToolbarPresence());

    act(() => result.current.setControlPresence("conversationView", "last"));

    expect(result.current.presence.conversationView).toBe("last");
    expect(
      JSON.parse(
        window.localStorage.getItem(UI_KEYS.sessionToolbarPresence) ?? "{}",
      ),
    ).toMatchObject({ conversationView: "last" });
    expect(getConversationViewPreference()).toBe(true);
    expect(window.localStorage.getItem(UI_KEYS.conversationView)).toBe("true");
    expect(mocks.updateServerSettings).not.toHaveBeenCalled();
  });

  it("does not reactivate Conversation view when only its visible tier changes", async () => {
    stubToolbarLayout(false);
    window.localStorage.setItem(UI_KEYS.conversationView, "false");
    const { useSessionToolbarPresence } = await import(
      "../useSessionToolbarPresence"
    );
    const { getConversationViewPreference } = await import(
      "../useConversationView"
    );
    const { result } = renderHook(() => useSessionToolbarPresence());

    act(() => result.current.setControlPresence("conversationView", "pin"));

    expect(result.current.presence.conversationView).toBe("pin");
    expect(getConversationViewPreference()).toBe(false);
  });

  it("ignores unknown controls in stored presence", async () => {
    stubToolbarLayout(false);
    window.localStorage.setItem(
      UI_KEYS.sessionToolbarPresence,
      JSON.stringify({
        modelIndicator: "pin",
        slashMenu: "hidden",
      }),
    );
    const { useSessionToolbarPresence } = await import(
      "../useSessionToolbarPresence"
    );

    const { result } = renderHook(() => useSessionToolbarPresence());

    expect(result.current.presence).not.toHaveProperty("modelIndicator");
    expect(result.current.presence.slashMenu).toBe("hidden");
  });

  it("resolves missing and defaulted controls from current defaults", async () => {
    stubToolbarLayout(true);
    window.localStorage.setItem(
      UI_KEYS.sessionToolbarPresence,
      JSON.stringify({
        slashMenu: "hidden",
        microphone: CLIENT_STORAGE_DEFAULT,
      }),
    );
    const { useSessionToolbarPresence } = await import(
      "../useSessionToolbarPresence"
    );

    const { result } = renderHook(() => useSessionToolbarPresence());

    expect(result.current.presence.slashMenu).toBe("hidden");
    expect(result.current.presence.microphone).toBe("pin");
    expect(result.current.presence.waveform).toBe("pin");
    // Mobile layout defaults hide the shortcuts help control.
    expect(result.current.presence.shortcutsHelp).toBe("hidden");
  });

  it("resolves locally defaulted controls from server client defaults", async () => {
    stubToolbarLayout(false);
    mocks.version = {
      clientDefaults: {
        sessionToolbarPresence: {
          conversationView: "hidden",
          renderMode: "last",
          slashMenu: "hidden",
        },
      },
    };
    window.localStorage.setItem(
      UI_KEYS.sessionToolbarPresence,
      JSON.stringify({ slashMenu: CLIENT_STORAGE_DEFAULT }),
    );
    const { useSessionToolbarPresence } = await import(
      "../useSessionToolbarPresence"
    );

    const { result } = renderHook(() => useSessionToolbarPresence());

    await waitFor(() => {
      expect(result.current.presence.renderMode).toBe("last");
      expect(result.current.presence.slashMenu).toBe("hidden");
      expect(result.current.presence.conversationView).toBe("last");
    });
  });

  it("keeps local explicit choices over server client defaults", async () => {
    stubToolbarLayout(false);
    mocks.version = {
      clientDefaults: {
        sessionToolbarPresence: {
          slashMenu: "hidden",
        },
      },
    };
    window.localStorage.setItem(
      UI_KEYS.sessionToolbarPresence,
      JSON.stringify({ slashMenu: "pin" }),
    );
    const { useSessionToolbarPresence } = await import(
      "../useSessionToolbarPresence"
    );

    const { result } = renderHook(() => useSessionToolbarPresence());

    await waitFor(() => {
      expect(result.current.presence.slashMenu).toBe("pin");
    });
  });

  it("masks Project Queue presence without server capability", async () => {
    stubToolbarLayout(false);
    mocks.version = {
      capabilities: [],
      clientDefaults: {
        sessionToolbarPresence: {
          projectQueue: "pin",
          projectQueueNewSessionShortcut: "pin",
        },
      },
    };
    const { useSessionToolbarPresence } = await import(
      "../useSessionToolbarPresence"
    );

    const { result } = renderHook(() => useSessionToolbarPresence());

    await waitFor(() => {
      expect(result.current.presence.projectQueue).toBe("hidden");
      expect(result.current.visibility.projectQueue).toBe(false);
      expect(result.current.presence.projectQueueNewSessionShortcut).toBe(
        "hidden",
      );
      expect(result.current.visibility.projectQueueNewSessionShortcut).toBe(
        false,
      );
    });
  });

  it("masks the shortcut without its dedicated settings capability", async () => {
    stubToolbarLayout(false);
    mocks.version = {
      capabilities: [PROJECT_QUEUE_CAPABILITY],
      clientDefaults: {
        sessionToolbarPresence: {
          projectQueue: "pin",
          projectQueueNewSessionShortcut: "pin",
        },
      },
    };
    const { useSessionToolbarPresence } = await import(
      "../useSessionToolbarPresence"
    );

    const { result } = renderHook(() => useSessionToolbarPresence());

    await waitFor(() => {
      expect(result.current.presence.projectQueue).toBe("pin");
      expect(result.current.visibility.projectQueue).toBe(true);
      expect(result.current.presence.projectQueueNewSessionShortcut).toBe(
        "hidden",
      );
      expect(result.current.visibility.projectQueueNewSessionShortcut).toBe(
        false,
      );
    });
  });

  it("can reveal the new-session Project Queue shortcut explicitly", async () => {
    stubToolbarLayout(false);
    mocks.version = {
      capabilities: [
        PROJECT_QUEUE_CAPABILITY,
        PROJECT_QUEUE_NEW_SESSION_SHORTCUT_SETTING_CAPABILITY,
      ],
      clientDefaults: {
        sessionToolbarPresence: {
          projectQueueNewSessionShortcut: "pin",
        },
      },
    };
    const { useSessionToolbarPresence } = await import(
      "../useSessionToolbarPresence"
    );

    const { result } = renderHook(() => useSessionToolbarPresence());

    await waitFor(() => {
      expect(result.current.visibility.projectQueue).toBe(false);
      expect(result.current.presence.projectQueueNewSessionShortcut).toBe(
        "pin",
      );
      expect(result.current.visibility.projectQueueNewSessionShortcut).toBe(
        true,
      );
    });
  });

  it("stores only explicit choices and reset returns to default", async () => {
    stubToolbarLayout(false);
    const { useSessionToolbarPresence } = await import(
      "../useSessionToolbarPresence"
    );
    const { result } = renderHook(() => useSessionToolbarPresence());

    act(() => result.current.setControlPresence("slashMenu", "hidden"));

    expect(
      JSON.parse(
        window.localStorage.getItem(UI_KEYS.sessionToolbarPresence) ?? "{}",
      ),
    ).toEqual({ slashMenu: "hidden" });
    expect(mocks.updateServerSettings).toHaveBeenCalledWith({
      clientDefaults: {
        sessionToolbarPresence: { slashMenu: "hidden" },
      },
    });

    act(() => result.current.resetPresence());

    expect(window.localStorage.getItem(UI_KEYS.sessionToolbarPresence)).toBe(
      null,
    );
    expect(result.current.presence.slashMenu).toBe("mid");
  });

  it("derives the priority projection with a tier for hidden controls", async () => {
    stubToolbarLayout(false);
    const { useSessionToolbarPresence } = await import(
      "../useSessionToolbarPresence"
    );

    const { result } = renderHook(() => useSessionToolbarPresence());

    expect(result.current.presence.renderMode).toBe("hidden");
    expect(result.current.priority.renderMode).toBe("last");
    expect(result.current.priority.slashMenu).toBe("mid");
  });

  it("migrates legacy visibility and priority maps into presence", async () => {
    stubToolbarLayout(false);
    window.localStorage.setItem(
      UI_KEYS.sessionToolbarVisibility,
      JSON.stringify({
        slashMenu: false,
        renderMode: true,
        btw: true,
        microphone: CLIENT_STORAGE_DEFAULT,
      }),
    );
    window.localStorage.setItem(
      UI_KEYS.sessionToolbarPriority,
      JSON.stringify({
        slashMenu: "pin",
        btw: "mid",
        contextUsage: "last",
      }),
    );
    const { useSessionToolbarPresence } = await import(
      "../useSessionToolbarPresence"
    );

    const { result } = renderHook(() => useSessionToolbarPresence());

    // Explicit hide wins over the stored tier; the tier is forgotten.
    expect(result.current.presence.slashMenu).toBe("hidden");
    // Explicit show with no tier falls to the control's default tier.
    expect(result.current.presence.renderMode).toBe("last");
    // Explicit show with a stored tier keeps that tier.
    expect(result.current.presence.btw).toBe("mid");
    // A tier alone carries over.
    expect(result.current.presence.contextUsage).toBe("last");
    // Sentinel "default" entries stay defaulted.
    expect(result.current.presence.microphone).toBe("pin");

    // Legacy keys are dropped; the folded map persists under the new key.
    expect(window.localStorage.getItem(UI_KEYS.sessionToolbarVisibility)).toBe(
      null,
    );
    expect(window.localStorage.getItem(UI_KEYS.sessionToolbarPriority)).toBe(
      null,
    );
    expect(
      JSON.parse(
        window.localStorage.getItem(UI_KEYS.sessionToolbarPresence) ?? "{}",
      ),
    ).toEqual({
      slashMenu: "hidden",
      renderMode: "last",
      btw: "mid",
      contextUsage: "last",
    });
  });

  it("prefers an existing presence map over legacy keys", async () => {
    stubToolbarLayout(false);
    window.localStorage.setItem(
      UI_KEYS.sessionToolbarPresence,
      JSON.stringify({ slashMenu: "pin" }),
    );
    window.localStorage.setItem(
      UI_KEYS.sessionToolbarVisibility,
      JSON.stringify({ slashMenu: false }),
    );
    const { useSessionToolbarPresence } = await import(
      "../useSessionToolbarPresence"
    );

    const { result } = renderHook(() => useSessionToolbarPresence());

    expect(result.current.presence.slashMenu).toBe("pin");
  });
});
