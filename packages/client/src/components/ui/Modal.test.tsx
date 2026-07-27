// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { Modal } from "./Modal";

describe("Modal closeOnBackGesture", () => {
  afterEach(() => {
    cleanup();
    window.history.replaceState({}, "", "/");
  });

  it("closes on a browser back (mobile back-swipe)", () => {
    const onClose = vi.fn();
    render(
      <I18nProvider>
        <Modal title="Diff" onClose={onClose} closeOnBackGesture>
          <div>body</div>
        </Modal>
      </I18nProvider>,
    );

    // Mounting pushed a history entry; a back gesture fires popstate.
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not touch history when the flag is off", () => {
    const onClose = vi.fn();
    render(
      <I18nProvider>
        <Modal title="Plain" onClose={onClose}>
          <div>body</div>
        </Modal>
      </I18nProvider>,
    );

    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("preserves the router state in the modal history entry", () => {
    const priorState = {
      usr: {
        defaultSession: {
          id: "origin-session",
        },
      },
      key: "router-entry",
    };
    window.history.replaceState(priorState, "", "/git-status");

    render(
      <I18nProvider>
        <Modal title="Diff" onClose={vi.fn()} closeOnBackGesture>
          <div>body</div>
        </Modal>
      </I18nProvider>,
    );

    expect(window.history.state).toEqual({
      ...priorState,
      yaModal: true,
    });
  });
});
