import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { SessionMetadataProvider } from "../../contexts/SessionMetadataContext";
import { I18nProvider } from "../../i18n";
import {
  clearCurrentSessionViewer,
  useSessionViewerController,
} from "../../lib/sessionViewerController";
import { ActivityDetailModal } from "../ActivityDetailModal";
import { SessionViewerProvider } from "../SessionManagedViewer";

function ViewerControllerProbe() {
  const viewer = useSessionViewerController();
  if (!viewer) return null;
  return (
    <>
      <button type="button" onClick={viewer.restore}>
        Restore managed viewer
      </button>
      <button type="button" onClick={viewer.close}>
        Close managed viewer
      </button>
    </>
  );
}

function StatefulContent() {
  const [count, setCount] = useState(0);
  return (
    <button type="button" onClick={() => setCount((value) => value + 1)}>
      Detail count {count}
    </button>
  );
}

function SessionHarness() {
  const [sourceMounted, setSourceMounted] = useState(true);
  const [open, setOpen] = useState(true);
  return (
    <I18nProvider>
      <SessionMetadataProvider
        projectId="project-1"
        projectPath="/workspace"
        sessionId="session-1"
      >
        <SessionViewerProvider sessionId="session-1">
          <button type="button" onClick={() => setSourceMounted(false)}>
            Unmount source row
          </button>
          {sourceMounted && open && (
            <ActivityDetailModal
              title="Bash Command"
              label="Bash Command"
              onClose={() => setOpen(false)}
            >
              <StatefulContent />
            </ActivityDetailModal>
          )}
          <ViewerControllerProbe />
        </SessionViewerProvider>
      </SessionMetadataProvider>
    </I18nProvider>
  );
}

describe("ActivityDetailModal", () => {
  afterEach(() => {
    act(() => clearCurrentSessionViewer());
    cleanup();
  });

  it("keeps one mounted detail subtree across parking and source removal", async () => {
    render(<SessionHarness />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Detail count 0" }),
    );
    expect(screen.getByRole("button", { name: "Detail count 1" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Minimize" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Unmount source row" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Restore managed viewer" }),
    );

    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Detail count 1" })).toBeTruthy();
  });

  it("does not let a retained session host clear another session's detail", async () => {
    render(
      <I18nProvider>
        <SessionMetadataProvider
          projectId="project-1"
          projectPath="/workspace"
          sessionId="session-1"
        >
          <SessionViewerProvider sessionId="session-1">
            <ActivityDetailModal
              title="Active session detail"
              label="Active session detail"
              onClose={() => {}}
            >
              Active session content
            </ActivityDetailModal>
          </SessionViewerProvider>
          <SessionViewerProvider sessionId="session-2" inactive>
            Parked session content
          </SessionViewerProvider>
        </SessionMetadataProvider>
      </I18nProvider>,
    );

    expect(await screen.findByText("Active session content")).toBeTruthy();
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText("Active session content")).toBeTruthy();
  });

  it("dismisses the previous source when another activity replaces it", async () => {
    function ReplacementHarness() {
      const [firstOpen, setFirstOpen] = useState(true);
      const [secondOpen, setSecondOpen] = useState(false);
      return (
        <I18nProvider>
          <SessionMetadataProvider
            projectId="project-1"
            projectPath="/workspace"
            sessionId="session-1"
          >
            <SessionViewerProvider sessionId="session-1">
              <button type="button" onClick={() => setSecondOpen(true)}>
                Open second
              </button>
              {!firstOpen && <span>First dismissed</span>}
              {firstOpen && (
                <ActivityDetailModal
                  title="First activity"
                  label="First activity"
                  onClose={() => setFirstOpen(false)}
                >
                  First content
                </ActivityDetailModal>
              )}
              {secondOpen && (
                <ActivityDetailModal
                  title="Second activity"
                  label="Second activity"
                  onClose={() => setSecondOpen(false)}
                >
                  Second content
                </ActivityDetailModal>
              )}
            </SessionViewerProvider>
          </SessionMetadataProvider>
        </I18nProvider>
      );
    }

    render(<ReplacementHarness />);
    expect(await screen.findByText("First content")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open second" }));

    await waitFor(() =>
      expect(screen.getByText("First dismissed")).toBeTruthy(),
    );
    expect(screen.queryByText("First content")).toBeNull();
    expect(screen.getByText("Second content")).toBeTruthy();
  });
});
