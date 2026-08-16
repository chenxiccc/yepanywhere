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

const {
  mockGetProcessInfo,
  mockGetProcessModels,
  mockSetProcessConfig,
  mockTranslate,
} = vi.hoisted(() => ({
  mockGetProcessInfo: vi.fn(),
  mockGetProcessModels: vi.fn(),
  mockSetProcessConfig: vi.fn(),
  mockTranslate: vi.fn((key: string) => key),
}));

vi.mock("../../api/client", () => ({
  api: {
    getProcessInfo: mockGetProcessInfo,
    getProcessModels: mockGetProcessModels,
    setProcessConfig: mockSetProcessConfig,
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
  useI18n: () => ({ t: mockTranslate }),
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
    mockSetProcessConfig.mockResolvedValue({
      success: true,
      processId: "process-1",
      model: "other",
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

    fireEvent.click(screen.getByRole("tab", { name: "newSessionModelTitle" }));

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

  it("dismisses dirty changes without saving", async () => {
    mockGetProcessModels.mockResolvedValue({
      models: [
        { id: "latest", name: "Latest" },
        { id: "other", name: "Other" },
      ],
    });
    const onClose = vi.fn();

    render(
      <ModelSwitchModal
        processId="process-1"
        sessionId="session-1"
        currentModel="latest"
        onModelChanged={vi.fn()}
        onClose={onClose}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: /Other/ }));
    fireEvent.click(screen.getByRole("button", { name: "modalClose" }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mockSetProcessConfig).not.toHaveBeenCalled();
  });

  it("dismisses while an explicit save remains pending", async () => {
    mockGetProcessModels.mockResolvedValue({
      models: [
        { id: "latest", name: "Latest" },
        { id: "other", name: "Other" },
      ],
    });
    let resolveConfig!: (result: {
      success: boolean;
      processId: string;
      model: string;
    }) => void;
    mockSetProcessConfig.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveConfig = resolve;
        }),
    );
    const onClose = vi.fn();
    const onModelChanged = vi.fn();

    render(
      <ModelSwitchModal
        processId="process-1"
        sessionId="session-1"
        currentModel="latest"
        onModelChanged={onModelChanged}
        onClose={onClose}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: /Other/ }));
    const saveButtons = await screen.findAllByRole("button", {
      name: /modelSwitchSaveAll/,
    });
    const saveButton = saveButtons[0];
    if (!saveButton) throw new Error("Expected a model save button");
    fireEvent.click(saveButton);
    await waitFor(() => {
      expect(mockSetProcessConfig).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(screen.getByRole("button", { name: "modalClose" }));
    expect(onClose).toHaveBeenCalledTimes(1);

    resolveConfig({ success: true, processId: "process-1", model: "other" });
    await waitFor(() => {
      expect(onModelChanged).toHaveBeenCalledTimes(1);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
