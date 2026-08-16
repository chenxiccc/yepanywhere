// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  CLAUDE_ADDITIONAL_MODELS_CAPABILITY,
  CLAUDE_GATEWAY_AUTOSTART_CAPABILITY,
  CLAUDE_GATEWAY_CAPABILITY,
  CLAUDE_GATEWAY_DISABLE_AGENT_CAPABILITY,
  CODEX_REASONING_SUMMARY_SETTING_CAPABILITY,
  IDLE_REAP_HOURS_SETTING_CAPABILITY,
  RELOAD_SAFE_CODEX_RUNTIME_CAPABILITY,
  RELOAD_SAFE_CODEX_RUNTIME_SETTINGS_CAPABILITY,
  SUBAGENT_MAX_DEPTH_SETTING_CAPABILITY,
  type ProviderInfo,
} from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerSettings } from "../../../api/client";
import { ProvidersSettings } from "../ProvidersSettings";

const {
  hookState,
  mockReloadProviders,
  mockUpdateSetting,
  mockUpdateSettings,
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
        supportsLaunchCompactPercentOverride: true,
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
  mockUpdateSettings: vi.fn(),
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
    updateSettings: mockUpdateSettings,
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
        supportsLaunchCompactPercentOverride: true,
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
    mockUpdateSettings.mockResolvedValue(undefined);
    mockReloadProviders.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("hides the setting when the connected server lacks the capability", () => {
    versionState.capabilities = [];

    render(<ProvidersSettings />);

    expect(screen.queryByText("providersAdditionalModelsTitle")).toBeNull();
  });

  it("hides idle harness lifetime from older servers", () => {
    render(<ProvidersSettings />);

    expect(screen.queryByText("providersIdleReapHoursLabel")).toBeNull();
    expect(screen.queryByText("providersSubagentMaxDepthLabel")).toBeNull();
  });

  it("hides Codex reasoning summaries from older servers", () => {
    render(<ProvidersSettings />);

    expect(
      screen.queryByText("providersCodexReasoningSummaryTitle"),
    ).toBeNull();
    expect(mockUpdateSetting).not.toHaveBeenCalled();
  });

  it("shows the default Codex reasoning-summary mode and saves exact values", async () => {
    versionState.capabilities = [CODEX_REASONING_SUMMARY_SETTING_CAPABILITY];
    render(<ProvidersSettings />);
    const select = screen.getByLabelText(
      "providersCodexReasoningSummaryAria",
    ) as HTMLSelectElement;

    expect(select.value).toBe("auto");
    fireEvent.change(select, { target: { value: "detailed" } });

    await waitFor(() => {
      expect(mockUpdateSetting).toHaveBeenCalledWith(
        "codexReasoningSummary",
        "detailed",
      );
    });
  });

  it("reflects a saved Codex reasoning-summary mode", () => {
    hookState.settings = {
      ...hookState.settings,
      codexReasoningSummary: "concise",
    };
    versionState.capabilities = [CODEX_REASONING_SUMMARY_SETTING_CAPABILITY];

    render(<ProvidersSettings />);

    expect(
      (
        screen.getByLabelText(
          "providersCodexReasoningSummaryAria",
        ) as HTMLSelectElement
      ).value,
    ).toBe("concise");
  });

  it("shows the Never notch as -1", () => {
    hookState.settings = {
      ...hookState.settings,
      idleReapHours: -1,
    };
    versionState.capabilities = [IDLE_REAP_HOURS_SETTING_CAPABILITY];

    render(<ProvidersSettings />);

    expect(screen.getByText("providersIdleReapHoursLabel")).toBeTruthy();
    expect(screen.getByText("providersIdleReapNeverHint")).toBeTruthy();
    expect(
      document.querySelector<HTMLInputElement>(
        "#providers-idle-reap-hours-control-number",
      )?.value,
    ).toBe("-1");
  });

  it("saves fractional idle harness hours from the number field", async () => {
    hookState.settings = {
      ...hookState.settings,
      idleReapHours: 24,
    };
    versionState.capabilities = [IDLE_REAP_HOURS_SETTING_CAPABILITY];
    render(<ProvidersSettings />);
    const numberInput = document.querySelector<HTMLInputElement>(
      "#providers-idle-reap-hours-control-number",
    );
    expect(numberInput).not.toBeNull();

    fireEvent.change(numberInput as HTMLInputElement, {
      target: { value: "2.5" },
    });
    fireEvent.blur(numberInput as HTMLInputElement);

    await waitFor(() => {
      expect(mockUpdateSetting).toHaveBeenCalledWith("idleReapHours", 2.5);
    });
  });

  it("shows the default subagent limit and provider coverage", () => {
    versionState.capabilities = [SUBAGENT_MAX_DEPTH_SETTING_CAPABILITY];

    render(<ProvidersSettings />);

    expect(screen.getByText("providersSubagentMaxDepthLabel")).toBeTruthy();
    expect(screen.getByText("providersSubagentMaxDepthCoverage")).toBeTruthy();
    expect(
      document.querySelector<HTMLInputElement>(
        "#providers-subagent-max-depth-control-number",
      )?.value,
    ).toBe("1");
  });

  it("renders provider-default subagent depth as an empty number", () => {
    hookState.settings = {
      ...hookState.settings,
      subagentMaxDepth: null,
    };
    versionState.capabilities = [SUBAGENT_MAX_DEPTH_SETTING_CAPABILITY];

    render(<ProvidersSettings />);

    expect(
      document.querySelector<HTMLInputElement>(
        "#providers-subagent-max-depth-control-number",
      )?.value,
    ).toBe("");
    expect(
      document.querySelector<HTMLInputElement>(
        "#providers-subagent-max-depth-control",
      )?.value,
    ).toBe("-1");
  });

  it("saves blank and zero subagent depth selections", async () => {
    hookState.settings = {
      ...hookState.settings,
      subagentMaxDepth: 2,
    };
    versionState.capabilities = [SUBAGENT_MAX_DEPTH_SETTING_CAPABILITY];
    render(<ProvidersSettings />);
    const numberInput = document.querySelector<HTMLInputElement>(
      "#providers-subagent-max-depth-control-number",
    );
    const slider = document.querySelector<HTMLInputElement>(
      "#providers-subagent-max-depth-control",
    );
    expect(numberInput).not.toBeNull();
    expect(slider).not.toBeNull();

    fireEvent.change(numberInput as HTMLInputElement, {
      target: { value: "" },
    });
    fireEvent.blur(numberInput as HTMLInputElement);
    await waitFor(() => {
      expect(mockUpdateSetting).toHaveBeenCalledWith("subagentMaxDepth", null);
    });

    mockUpdateSetting.mockClear();
    fireEvent.change(slider as HTMLInputElement, { target: { value: "0" } });
    fireEvent.pointerUp(slider as HTMLInputElement);
    await waitFor(() => {
      expect(mockUpdateSetting).toHaveBeenCalledWith("subagentMaxDepth", 0);
    });
  });

  it("shows Codex before Claude", () => {
    render(<ProvidersSettings />);

    const providerRows = Array.from(
      document.querySelectorAll<HTMLElement>(
        '[data-settings-item^="provider-"]',
      ),
    );
    expect(
      providerRows.slice(0, 2).map((row) => row.dataset.settingsItem),
    ).toEqual(["provider-codex", "provider-claude"]);
  });

  it("hides legacy reload-safe Codex settings when advertised", () => {
    hookState.providers = [
      {
        name: "codex",
        displayName: "Codex",
        installed: false,
        authenticated: true,
        enabled: true,
        models: [],
      },
    ];
    versionState.capabilities = [
      RELOAD_SAFE_CODEX_RUNTIME_SETTINGS_CAPABILITY,
      RELOAD_SAFE_CODEX_RUNTIME_CAPABILITY,
    ];

    render(<ProvidersSettings />);

    expect(screen.queryByText("providersCodexReloadSafeTitle")).toBeNull();
  });

  it("hides the Claude auto-compaction setting from older servers", () => {
    hookState.providers = hookState.providers.map((provider) => ({
      ...provider,
      supportsLaunchCompactPercentOverride: undefined,
    }));

    render(<ProvidersSettings />);

    expect(screen.queryByText("providersClaudeAutoCompactTitle")).toBeNull();
  });

  it("saves and clears the global Claude auto-compaction setting", async () => {
    const { unmount } = render(<ProvidersSettings />);
    const numberInput = screen
      .getAllByLabelText("providersClaudeAutoCompactTitle")
      .find((element) => element.getAttribute("type") === "number");
    expect(numberInput).toBeDefined();

    fireEvent.change(numberInput!, { target: { value: "60" } });
    fireEvent.blur(numberInput!);

    await waitFor(() => {
      expect(mockUpdateSetting).toHaveBeenCalledWith(
        "claudeAutoCompactPercentOverride",
        60,
      );
    });

    unmount();
    vi.clearAllMocks();
    mockUpdateSetting.mockResolvedValue(undefined);
    hookState.settings = {
      serviceWorkerEnabled: true,
      persistRemoteSessionsToDisk: false,
      claudeAdditionalModels: [],
      claudeAutoCompactPercentOverride: 60,
    };

    render(<ProvidersSettings />);
    const configuredInput = screen
      .getAllByLabelText("providersClaudeAutoCompactTitle")
      .find((element) => element.getAttribute("type") === "number");
    expect(configuredInput).toBeDefined();

    fireEvent.change(configuredInput!, { target: { value: "0" } });
    fireEvent.blur(configuredInput!);

    await waitFor(() => {
      expect(mockUpdateSetting).toHaveBeenCalledWith(
        "claudeAutoCompactPercentOverride",
        undefined,
      );
    });
  });

  it("shows a compact empty summary and saves maintained opt-ins", async () => {
    render(<ProvidersSettings />);

    fireEvent.click(
      screen.getByRole("button", {
        name: /providersAdditionalModelsNone/u,
      }),
    );
    fireEvent.click(screen.getByRole("checkbox", { name: /Opus 4\.8/u }));

    await waitFor(() => {
      expect(mockUpdateSetting).toHaveBeenCalledWith("claudeAdditionalModels", [
        {
          id: "claude-opus-4-8",
          label: "Opus 4.8",
          origin: "registry",
        },
      ]);
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
    fireEvent.click(screen.getByText("providersAdditionalModelsCustomTitle"));
    fireEvent.change(
      screen.getByPlaceholderText("providersAdditionalModelsCustomPlaceholder"),
      { target: { value: "claude-experimental-6" } },
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "providersAdditionalModelsAdd",
      }),
    );

    await waitFor(() => {
      expect(mockUpdateSetting).toHaveBeenCalledWith("claudeAdditionalModels", [
        {
          id: "claude-experimental-6",
          label: "claude-experimental-6",
          origin: "custom",
        },
      ]);
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

    expect(screen.getByRole("checkbox", { name: /Opus 4\.5/u })).toHaveProperty(
      "checked",
      true,
    );
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

    const gatewayCard = document.querySelector<HTMLElement>(
      '[data-settings-item="provider-claude-gateway"]',
    );
    expect(gatewayCard).not.toBeNull();
    expect(
      within(gatewayCard as HTMLElement).getByText(
        "providersClaudeGatewayTitle",
      ),
    ).toBeTruthy();

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

  it("submits Claude Gateway edits through its form", async () => {
    versionState.capabilities = [CLAUDE_GATEWAY_CAPABILITY];
    render(<ProvidersSettings />);

    const input = screen.getByRole("textbox", {
      name: "providersClaudeGatewayUrlAria",
    });
    fireEvent.change(input, {
      target: { value: "http://localhost:4242" },
    });
    const form = input.closest("form");
    expect(form).not.toBeNull();
    fireEvent.submit(form as HTMLFormElement);

    await waitFor(() => {
      expect(mockUpdateSetting).toHaveBeenCalledWith(
        "claudeGatewayUrl",
        "http://localhost:4242",
      );
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

  it("hides Gateway autostart from servers with only the base capability", () => {
    versionState.capabilities = [CLAUDE_GATEWAY_CAPABILITY];
    render(<ProvidersSettings />);

    expect(
      screen.queryByRole("textbox", {
        name: "providersClaudeGatewayStartCommandAria",
      }),
    ).toBeNull();
    expect(
      screen.queryByRole("checkbox", {
        name: "providersClaudeGatewayDisableAgentTitle",
      }),
    ).toBeNull();
  });

  it("defaults the capability-gated Gateway Agent denial on", () => {
    versionState.capabilities = [
      CLAUDE_GATEWAY_CAPABILITY,
      CLAUDE_GATEWAY_DISABLE_AGENT_CAPABILITY,
    ];
    render(<ProvidersSettings />);

    const checkbox = screen.getByRole("checkbox", {
      name: "providersClaudeGatewayDisableAgentTitle",
    });
    expect(checkbox).toHaveProperty("checked", true);

    fireEvent.click(checkbox);

    expect(mockUpdateSetting).toHaveBeenCalledWith(
      "claudeGatewayDisableAgent",
      false,
    );
  });

  it("saves a capability-gated Gateway start command with the URL", async () => {
    versionState.capabilities = [
      CLAUDE_GATEWAY_CAPABILITY,
      CLAUDE_GATEWAY_AUTOSTART_CAPABILITY,
    ];
    render(<ProvidersSettings />);

    fireEvent.change(
      screen.getByRole("textbox", {
        name: "providersClaudeGatewayUrlAria",
      }),
      { target: { value: "http://localhost:4041" } },
    );
    fireEvent.change(
      screen.getByRole("textbox", {
        name: "providersClaudeGatewayStartCommandAria",
      }),
      {
        target: {
          value:
            "cd /srv/copilot-api && HOST=localhost bun run ./src/main.ts start --port 4041",
        },
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "providersSave" }));

    await waitFor(() => {
      expect(mockUpdateSettings).toHaveBeenCalledWith({
        claudeGatewayUrl: "http://localhost:4041",
        claudeGatewayStartCommand:
          "cd /srv/copilot-api && HOST=localhost bun run ./src/main.ts start --port 4041",
      });
      expect(mockReloadProviders).toHaveBeenCalledTimes(1);
    });
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
