// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelSwitchModal } from "../ModelSwitchModal";

const { mockGetProcessInfo, mockGetProcessModels } = vi.hoisted(() => ({
  mockGetProcessInfo: vi.fn(),
  mockGetProcessModels: vi.fn(),
}));

vi.mock("../../api/client", () => ({
  api: {
    getProcessInfo: mockGetProcessInfo,
    getProcessModels: mockGetProcessModels,
  },
}));

vi.mock("../../hooks/useModelSettings", () => ({
  getEffortLevel: () => "high",
  getShowThinkingSetting: () => true,
  getThinkingMode: () => "off",
  useModelSettings: () => ({
    setEffortLevel: vi.fn(),
    setThinkingMode: vi.fn(),
  }),
}));

vi.mock("../../hooks/useProviderSubscriptionUsage", () => ({
  useProviderSubscriptionUsage: () => ({
    usage: null,
    loading: false,
    supported: false,
    refresh: vi.fn(),
  }),
}));

vi.mock("../../i18n", () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}));

describe("ModelSwitchModal", () => {
  beforeEach(() => {
    mockGetProcessModels.mockResolvedValue({ models: [] });
    mockGetProcessInfo.mockResolvedValue({
      process: {
        model: "latest",
        provider: "claude",
        thinking: undefined,
        effort: "high",
      },
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("resets the shared modal scroller when switching tabs", () => {
    render(
      <ModelSwitchModal
        sessionId="session-1"
        currentModel="model-1"
        infoPane={<div>Session details</div>}
        initialTab="info"
        onModelChanged={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const modalContent = document.querySelector(".modal-content");
    expect(modalContent).toBeInstanceOf(HTMLElement);
    const scrollTo = vi.fn();
    Object.defineProperty(modalContent, "scrollTo", { value: scrollTo });

    fireEvent.click(
      screen.getByRole("tab", { name: "newSessionModelTitle" }),
    );

    expect(scrollTo).toHaveBeenCalledWith({ top: 0 });
    expect(screen.queryByText("Session details")).toBeNull();
  });

  it("groups additional choices and preserves a missing current model", async () => {
    mockGetProcessModels.mockResolvedValue({
      models: [
        { id: "latest", name: "Latest" },
        {
          id: "previous",
          name: "Previous",
          catalogGroup: "additional",
        },
      ],
    });
    mockGetProcessInfo.mockResolvedValue({
      process: {
        model: "removed-current",
        provider: "claude",
        thinking: undefined,
        effort: "high",
      },
    });

    render(
      <ModelSwitchModal
        processId="process-1"
        sessionId="session-1"
        currentModel="removed-current"
        onModelChanged={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Previous")).toBeTruthy();
    });
    expect(screen.getAllByText("previousModelsGroup")).toHaveLength(1);
    expect(screen.getAllByText("removed-current").length).toBeGreaterThan(0);
    expect(screen.getByText("modelSelectionUnavailable")).toBeTruthy();
  });
});
