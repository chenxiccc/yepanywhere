// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InputRequest } from "../../types";
import styles from "../ToolApprovalPanel.module.css";
import { ToolApprovalPanel } from "../ToolApprovalPanel";

const translations: Record<string, string> = {
  toolApprovalCollapse: "Collapse approval",
  toolApprovalExpand: "Expand approval",
  toolApprovalNo: "No",
  toolApprovalSend: "Send",
  toolApprovalTellInstead: "Tell Claude instead",
  toolApprovalFeedbackPlaceholder: "What should change?",
  toolApprovalYes: "Yes",
};

vi.mock("../../i18n", () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      if (key === "toolApprovalAllow") {
        return `Allow ${String(params?.tool ?? "")} ${String(params?.summary ?? "")}?`;
      }
      return translations[key] ?? key;
    },
  }),
}));

vi.mock("../../hooks/useDrafts", () => ({
  useToolApprovalFeedbackDraft: () => ["", vi.fn(), vi.fn()],
}));

vi.mock("../renderers/tools", () => ({
  toolRegistry: {
    renderToolUse: vi.fn(),
  },
}));

vi.mock("../tools/summaries", () => ({
  getToolSummary: () => "wget --spider https://example.org",
}));

const request: InputRequest = {
  id: "request-1",
  sessionId: "session-1",
  type: "tool-approval",
  prompt: "Allow the command?",
  toolName: "Bash",
  toolInput: { command: "wget --spider https://example.org?" },
  timestamp: "2026-08-01T00:00:00.000Z",
};

function renderPanel(
  props: Partial<ComponentProps<typeof ToolApprovalPanel>> = {},
) {
  return render(
    <ToolApprovalPanel
      request={request}
      sessionId="session-1"
      onApprove={vi.fn(async () => {})}
      onDeny={vi.fn(async () => {})}
      {...props}
    />,
  );
}

describe("ToolApprovalPanel", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("renders the approval surface with module-owned classes", () => {
    const { container } = renderPanel();
    const root = container.firstElementChild;

    expect(root).toBeTruthy();
    expect(root?.classList.contains(styles.root!)).toBe(true);
    expect(root?.querySelector(`.${styles.toggle}`)).toBeTruthy();
    expect(root?.querySelector(`.${styles.panel}`)).toBeTruthy();
    expect(root?.querySelector(`.${styles.question}`)?.textContent).toBe(
      "Allow Bash wget --spider https://example.org?",
    );
    expect(root?.querySelector(`.${styles.option}`)).toBeTruthy();

    const renderedClasses = Array.from(root?.querySelectorAll("[class]") ?? [])
      .map((element) => element.className)
      .join(" ");
    expect(renderedClasses).not.toContain("tool-approval-");
  });

  it("keeps collapse and keyboard approval actions wired to the panel", async () => {
    const onApprove = vi.fn(async () => {});
    const onDeny = vi.fn(async () => {});
    const onCollapsedChange = vi.fn();
    const { container, rerender } = render(
      <ToolApprovalPanel
        request={request}
        sessionId="session-1"
        onApprove={onApprove}
        onDeny={onDeny}
        onCollapsedChange={onCollapsedChange}
      />,
    );

    await act(async () => {
      vi.advanceTimersByTime(150);
    });

    await act(async () => {
      fireEvent.keyDown(window, { key: "Enter" });
      await Promise.resolve();
    });
    expect(onApprove).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Collapse approval" }));
    expect(onCollapsedChange).toHaveBeenCalledWith(true);

    rerender(
      <ToolApprovalPanel
        request={request}
        sessionId="session-1"
        onApprove={onApprove}
        onDeny={onDeny}
        collapsed
        onCollapsedChange={onCollapsedChange}
      />,
    );

    const root = container.firstElementChild;
    const toggle = screen.getByRole("button", { name: "Expand approval" });
    expect(root?.querySelector(`.${styles.panel}`)).toBeNull();
    expect(toggle.classList.contains(styles.hasPending!)).toBe(true);
    expect(
      toggle.querySelector("svg")?.classList.contains(styles.chevronUp!),
    ).toBe(true);
    fireEvent.click(toggle);
    expect(onCollapsedChange).toHaveBeenLastCalledWith(false);
  });
});
