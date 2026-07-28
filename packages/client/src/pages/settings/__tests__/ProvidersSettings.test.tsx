// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  CLAUDE_ADDITIONAL_MODELS_CAPABILITY,
  CLAUDE_GATEWAY_CAPABILITY,
  type ProviderInfo,
} from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerSettings } from "../../../api/client";
import { ProvidersSettings } from "../ProvidersSettings";

const {
  hookState,
  mockReloadProviders,
  mockUpdateSetting,
  versionState,
} = vi.hoisted(() => ({
  hookState: {
    settings: {
      serviceWorkerEnabled: true,
      persistRemoteSessionsToDisk: false,
      claudeAdditionalModels: [],
    } as ServerSettings,
    providers: [
      {
        name: "claude",
        displayName: "Claude",
        installed: true,
        authenticated: true,
        enabled: true,
        models: [{ id: "opus", name: "Opus" }],
        additionalModelOptions: [
          {
            id: "claude-opus-4-8",
            name: "Opus 4.8",
            description: "Previous Opus generation",
            catalogGroup: "additional",
          },
        ],
      },
    ] as ProviderInfo[],
  },
  mockReloadProviders: vi.fn(),
  mockUpdateSetting: vi.fn(),
  versionState: {
    capabilities: [] as string[],
  },
}));

vi.mock("../../../contexts/ToastContext", () => ({
  useToastContext: () => ({ showToast: vi.fn() }),
}));

vi.mock("../../../hooks/useProviders", () => ({
  useProviders: () => ({
    providers: hookState.providers,
    loading: false,
    error: null,
    refetch: vi.fn(),
    reload: mockReloadProviders,
  }),
}));

vi.mock("../../../hooks/useServerSettings", () => ({
  useServerSettings: () => ({
    settings: hookState.settings,
    isLoading: false,
    error: null,
    updateSetting: mockUpdateSetting,
    updateSettings: vi.fn(),
    refetch: vi.fn(),
  }),
}));

vi.mock("../../../hooks/useVersion", () => ({
  useVersion: () => ({
    version: { capabilities: versionState.capabilities },
  }),
}));

vi.mock("../../../i18n", () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, string>) =>
      params?.count ? `${key}:${params.count}` : key,
  }),
}));

describe("ProvidersSettings additional models", () => {
  beforeEach(() => {
    window.localStorage.clear();
    hookState.settings = {
      serviceWorkerEnabled: true,
      persistRemoteSessionsToDisk: false,
      claudeAdditionalModels: [],
    };
    hookState.providers = [
      {
        name: "claude",
        displayName: "Claude",
        installed: true,
        authenticated: true,
        enabled: true,
        models: [{ id: "opus", name: "Opus" }],
        additionalModelOptions: [
          {
            id: "claude-opus-4-8",
            name: "Opus 4.8",
            description: "Previous Opus generation",
            catalogGroup: "additional",
          },
        ],
      },
    ];
    versionState.capabilities = [CLAUDE_ADDITIONAL_MODELS_CAPABILITY];
    mockUpdateSetting.mockResolvedValue(undefined);
    mockReloadProviders.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("hides the setting when the connected server lacks the capability", () => {
    versionState.capabilities = [];

    render(<ProvidersSettings />);

    expect(
      screen.queryByText("providersAdditionalModelsTitle"),
    ).toBeNull();
  });

  it("shows a compact empty summary and saves maintained opt-ins", async () => {
    render(<ProvidersSettings />);

    fireEvent.click(
      screen.getByRole("button", {
        name: /providersAdditionalModelsNone/u,
      }),
    );
    fireEvent.click(
      screen.getByRole("checkbox", { name: /Opus 4\.8/u }),
    );

    await waitFor(() => {
      expect(mockUpdateSetting).toHaveBeenCalledWith(
        "claudeAdditionalModels",
        [
          {
            id: "claude-opus-4-8",
            label: "Opus 4.8",
            origin: "registry",
          },
        ],
      );
      expect(mockReloadProviders).toHaveBeenCalledTimes(1);
    });
  });

  it("adds a custom exact id from the advanced editor", async () => {
    render(<ProvidersSettings />);

    fireEvent.click(
      screen.getByRole("button", {
        name: /providersAdditionalModelsNone/u,
      }),
    );
    fireEvent.click(
      screen.getByText("providersAdditionalModelsCustomTitle"),
    );
    fireEvent.change(
      screen.getByPlaceholderText(
        "providersAdditionalModelsCustomPlaceholder",
      ),
      { target: { value: "claude-experimental-6" } },
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "providersAdditionalModelsAdd",
      }),
    );

    await waitFor(() => {
      expect(mockUpdateSetting).toHaveBeenCalledWith(
        "claudeAdditionalModels",
        [
          {
            id: "claude-experimental-6",
            label: "claude-experimental-6",
            origin: "custom",
          },
        ],
      );
    });
  });

  it("keeps a removed registry selection visible for opt-out", () => {
    hookState.settings = {
      serviceWorkerEnabled: true,
      persistRemoteSessionsToDisk: false,
      claudeAdditionalModels: [
        {
          id: "claude-opus-4-5",
          label: "Opus 4.5",
          origin: "registry",
        },
      ],
    };

    render(<ProvidersSettings />);
    fireEvent.click(
      screen.getByRole("button", { name: /providersAdditionalModelsOne/u }),
    );

    expect(
      screen.getByRole("checkbox", { name: /Opus 4\.5/u }),
    ).toHaveProperty("checked", true);
    expect(
      screen.getByText("providersAdditionalModelsUnlistedDescription"),
    ).toBeTruthy();
  });

  it("hides Claude Gateway configuration from older servers", () => {
    render(<ProvidersSettings />);

    expect(screen.queryByText("providersClaudeGatewayTitle")).toBeNull();
  });

  it("saves isolated Claude Gateway configuration and reloads providers", async () => {
    versionState.capabilities = [CLAUDE_GATEWAY_CAPABILITY];
    render(<ProvidersSettings />);

    fireEvent.change(
      screen.getByRole("textbox", {
        name: "providersClaudeGatewayUrlAria",
      }),
      { target: { value: "http://localhost:4141" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "providersSave" }));

    await waitFor(() => {
      expect(mockUpdateSetting).toHaveBeenCalledWith(
        "claudeGatewayUrl",
        "http://localhost:4141",
      );
      expect(mockReloadProviders).toHaveBeenCalledTimes(1);
    });
  });

  it("materializes the Claude Gateway example URL on focus", () => {
    versionState.capabilities = [CLAUDE_GATEWAY_CAPABILITY];
    render(<ProvidersSettings />);

    const input = screen.getByRole("textbox", {
      name: "providersClaudeGatewayUrlAria",
    });
    expect(input).toHaveProperty("value", "");

    fireEvent.focus(input);

    expect(input).toHaveProperty("value", "http://localhost:4141");
    expect(mockUpdateSetting).not.toHaveBeenCalled();
  });

  it("hides legacy ClaudeOllama when the server has no configuration or use", () => {
    render(<ProvidersSettings />);

    expect(screen.queryByText("Claude + Ollama")).toBeNull();
  });

  it("keeps legacy ClaudeOllama visible when the server advertises it", () => {
    hookState.providers = [
      ...hookState.providers,
      {
        name: "claude-ollama",
        displayName: "Claude + Ollama",
        installed: true,
        authenticated: true,
        enabled: true,
        models: [],
      },
    ];

    render(<ProvidersSettings />);

    expect(screen.getByText("Claude + Ollama")).toBeTruthy();
    expect(
      screen.getByText("providersClaudeOllamaDeprecationNotice"),
    ).toBeTruthy();
  });

  it("permanently dismisses the ClaudeOllama deprecation notice", () => {
    hookState.providers = [
      ...hookState.providers,
      {
        name: "claude-ollama",
        displayName: "Claude + Ollama",
        installed: true,
        authenticated: true,
        enabled: true,
        models: [],
      },
    ];

    const { unmount } = render(<ProvidersSettings />);
    fireEvent.click(
      screen.getByRole("button", {
        name: "providersClaudeOllamaDeprecationDismissAria",
      }),
    );
    expect(
      screen.queryByText("providersClaudeOllamaDeprecationNotice"),
    ).toBeNull();

    unmount();
    render(<ProvidersSettings />);
    expect(
      screen.queryByText("providersClaudeOllamaDeprecationNotice"),
    ).toBeNull();
  });
});
