// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UI_KEYS } from "../../lib/storageKeys";
import {
  __resetDeveloperModeForTest,
  getRemoteLogCollectionEnabled,
  useDeveloperMode,
} from "../useDeveloperMode";

describe("useDeveloperMode", () => {
  beforeEach(() => {
    window.localStorage.clear();
    __resetDeveloperModeForTest();
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    __resetDeveloperModeForTest();
  });

  it("defaults experimental developer features to disabled", () => {
    const { result } = renderHook(() => useDeveloperMode());

    expect(result.current.crossHostDelegationEnabled).toBe(false);
    expect(result.current.remoteLogCollectionEnabled).toBe(false);
    expect(getRemoteLogCollectionEnabled()).toBe(false);
  });

  it("persists and publishes the cross-host delegation preview toggle", () => {
    const { result: first } = renderHook(() => useDeveloperMode());
    const { result: second } = renderHook(() => useDeveloperMode());

    act(() => {
      first.current.setCrossHostDelegationEnabled(true);
    });

    expect(first.current.crossHostDelegationEnabled).toBe(true);
    expect(second.current.crossHostDelegationEnabled).toBe(true);
    expect(
      JSON.parse(localStorage.getItem(UI_KEYS.developerMode) ?? "{}"),
    ).toMatchObject({
      crossHostDelegationEnabled: true,
    });
  });

  it("persists and publishes remote log collection updates", () => {
    const { result: first } = renderHook(() => useDeveloperMode());
    const { result: second } = renderHook(() => useDeveloperMode());

    act(() => {
      first.current.setRemoteLogCollectionEnabled(true);
    });

    expect(first.current.remoteLogCollectionEnabled).toBe(true);
    expect(second.current.remoteLogCollectionEnabled).toBe(true);
    expect(getRemoteLogCollectionEnabled()).toBe(true);
    expect(
      JSON.parse(localStorage.getItem(UI_KEYS.developerMode) ?? "{}"),
    ).toMatchObject({
      remoteLogCollectionEnabled: true,
    });
  });
});
