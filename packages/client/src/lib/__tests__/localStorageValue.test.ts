import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLocalStorageBoolean,
  createLocalStorageValue,
} from "../localStorageValue";

const MODES = ["block", "paragraph-hover", "paragraph-always"] as const;
type Mode = (typeof MODES)[number];

function parseMode(raw: string): Mode | undefined {
  return (MODES as readonly string[]).includes(raw)
    ? (raw as Mode)
    : undefined;
}

function createModeStore(key = "test-mode-key") {
  return createLocalStorageValue<Mode>(key, "paragraph-hover", parseMode);
}

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("createLocalStorageValue", () => {
  it("reads the default when the key is absent", () => {
    expect(createModeStore().read()).toBe("paragraph-hover");
  });

  it("reads the default when parse rejects the stored value", () => {
    localStorage.setItem("test-mode-key", "garbage");
    expect(createModeStore().read()).toBe("paragraph-hover");
  });

  it("reads the default when storage access throws", () => {
    const getItem = vi
      .spyOn(localStorage, "getItem")
      .mockImplementation(() => {
        throw new Error("denied");
      });
    const store = createModeStore();

    expect(store.read()).toBe("paragraph-hover");
    getItem.mockRestore();
    localStorage.setItem("test-mode-key", "block");

    expect(store.read()).toBe("block");
  });

  it("reads backing storage only while initializing its snapshot", () => {
    localStorage.setItem("test-mode-key", "block");
    const getItem = vi.spyOn(localStorage, "getItem");
    const store = createModeStore();

    expect(store.read()).toBe("block");
    expect(store.read()).toBe("block");
    expect(store.read()).toBe("block");

    expect(getItem).toHaveBeenCalledTimes(1);
  });

  it("does not mark an unavailable server snapshot initialized", () => {
    const descriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      "localStorage",
    );
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: undefined,
    });
    const store = createModeStore();
    expect(store.read()).toBe("paragraph-hover");

    if (descriptor) {
      Object.defineProperty(globalThis, "localStorage", descriptor);
    } else {
      throw new Error("Expected jsdom localStorage descriptor");
    }
    localStorage.setItem("test-mode-key", "block");
    expect(store.read()).toBe("block");
  });

  it("keeps the in-memory value when persistence fails", () => {
    vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    const store = createModeStore();
    const listener = vi.fn();
    store.subscribe(listener);

    store.set("block");

    expect(store.read()).toBe("block");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("persists on set and notifies subscribers", () => {
    const store = createModeStore();
    const listener = vi.fn();
    store.subscribe(listener);

    store.set("block");

    expect(localStorage.getItem("test-mode-key")).toBe("block");
    expect(store.read()).toBe("block");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("does not notify subscribers for an unchanged effective value", () => {
    const store = createModeStore();
    const listener = vi.fn();
    store.subscribe(listener);

    store.set("paragraph-hover");

    expect(listener).not.toHaveBeenCalled();
  });

  it("requires explicit invalidation after a raw same-tab write", () => {
    const store = createModeStore();
    expect(store.read()).toBe("paragraph-hover");

    localStorage.setItem("test-mode-key", "paragraph-always");
    expect(store.read()).toBe("paragraph-hover");

    store.invalidate();
    expect(store.read()).toBe("paragraph-always");
  });

  it("resets storage and the in-memory snapshot", () => {
    const store = createModeStore();
    store.set("block");

    store.reset();

    expect(localStorage.getItem("test-mode-key")).toBeNull();
    expect(store.read()).toBe("paragraph-hover");
  });

  it("reconciles cross-tab storage events for its key", () => {
    const store = createModeStore();
    const listener = vi.fn();
    store.subscribe(listener);
    expect(store.read()).toBe("paragraph-hover");

    window.dispatchEvent(
      new StorageEvent("storage", { key: "test-mode-key", newValue: "block" }),
    );
    window.dispatchEvent(
      new StorageEvent("storage", { key: "unrelated-key", newValue: "x" }),
    );

    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.read()).toBe("block");
  });

  it("invalidates on cross-tab storage clear events", () => {
    const store = createModeStore();
    store.subscribe(() => {});
    expect(store.read()).toBe("paragraph-hover");
    store.set("block");
    localStorage.clear();

    window.dispatchEvent(new StorageEvent("storage", { key: null }));

    expect(store.read()).toBe("paragraph-hover");
  });

  it("revalidates after all cross-tab listeners were detached", () => {
    localStorage.setItem("test-mode-key", "block");
    const store = createModeStore();
    expect(store.read()).toBe("block");
    const unsubscribe = store.subscribe(() => {});
    unsubscribe();

    localStorage.setItem("test-mode-key", "paragraph-always");
    store.subscribe(() => {});

    expect(store.read()).toBe("paragraph-always");
  });

  it("shares one window storage listener and detaches at zero subscribers", () => {
    const addSpy = vi.spyOn(window, "addEventListener");
    const removeSpy = vi.spyOn(window, "removeEventListener");
    const store = createModeStore();

    const unsubscribeA = store.subscribe(() => {});
    const unsubscribeB = store.subscribe(() => {});
    const storageAdds = addSpy.mock.calls.filter(
      (call) => call[0] === "storage",
    );
    expect(storageAdds).toHaveLength(1);

    unsubscribeA();
    expect(
      removeSpy.mock.calls.filter((call) => call[0] === "storage"),
    ).toHaveLength(0);

    unsubscribeB();
    expect(
      removeSpy.mock.calls.filter((call) => call[0] === "storage"),
    ).toHaveLength(1);
  });
});

describe("createLocalStorageBoolean", () => {
  it("reads the default only when the key is absent", () => {
    const store = createLocalStorageBoolean("test-bool-key", true);
    expect(store.read()).toBe(true);
  });

  it("reads any present non-'true' value as false, not as the default", () => {
    localStorage.setItem("test-bool-key", "garbage");
    const store = createLocalStorageBoolean("test-bool-key", true);
    expect(store.read()).toBe(false);
  });

  it("round-trips true/false through set", () => {
    const store = createLocalStorageBoolean("test-bool-key", false);
    store.set(true);
    expect(localStorage.getItem("test-bool-key")).toBe("true");
    expect(store.read()).toBe(true);
    store.set(false);
    expect(store.read()).toBe(false);
  });
});
