// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
    window.history.replaceState({}, "", "/");
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
      yaModal: expect.stringMatching(/^yaModal-\d+$/),
    });
  });

  it("closes only the topmost Backspace owner", () => {
    const closeParent = vi.fn();
    const closeChild = vi.fn();
    render(
      <I18nProvider>
        <Modal title="Parent" onClose={closeParent} closeOnBackspace>
          <div>parent body</div>
        </Modal>
        <Modal title="Child" onClose={closeChild} closeOnBackspace>
          <div>child body</div>
        </Modal>
      </I18nProvider>,
    );

    fireEvent.keyDown(document, { key: "Backspace" });

    expect(closeChild).toHaveBeenCalledTimes(1);
    expect(closeParent).not.toHaveBeenCalled();
  });

  it("leaves Backspace to editable controls", () => {
    const onClose = vi.fn();
    render(
      <I18nProvider>
        <Modal title="Editor" onClose={onClose} closeOnBackspace>
          <input aria-label="Filename" />
        </Modal>
      </I18nProvider>,
    );

    const input = screen.getByRole("textbox", { name: "Filename" });
    fireEvent.keyDown(input, { key: "Backspace" });
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(document, { key: "Backspace" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("gives Escape and body-scroll ownership to the topmost modal", () => {
    const closeParent = vi.fn();
    const closeChild = vi.fn();
    document.body.style.overflow = "clip";
    const { rerender, unmount } = render(
      <I18nProvider>
        <Modal title="Parent" onClose={closeParent}>
          <div>parent body</div>
          <Modal title="Child" onClose={closeChild}>
            <div>child body</div>
          </Modal>
        </Modal>
      </I18nProvider>,
    );

    expect(document.body.style.overflow).toBe("hidden");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(closeChild).toHaveBeenCalledTimes(1);
    expect(closeParent).not.toHaveBeenCalled();

    rerender(
      <I18nProvider>
        <Modal title="Parent" onClose={closeParent}>
          <div>parent body</div>
        </Modal>
      </I18nProvider>,
    );
    expect(document.body.style.overflow).toBe("hidden");
    unmount();
    expect(document.body.style.overflow).toBe("clip");
    document.body.style.overflow = "";
  });
});
