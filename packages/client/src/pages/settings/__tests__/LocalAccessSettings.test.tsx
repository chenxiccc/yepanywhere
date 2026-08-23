// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { APPROVAL_AUDIT_LOG_CAPABILITY } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  FileAccessInfo,
  FileAccessSettings,
  ServerSettings,
} from "../../../api/client";
import { LocalAccessSettings } from "../LocalAccessSettings";
import {
  type SettingsUndoRegistration,
  SettingsUndoProvider,
} from "../SettingsUndoContext";

const {
  hookState,
  mockDisconnect,
  mockGetFileAccessInfo,
  mockUpdateSetting,
  mockUpdateSettings,
  remoteState,
  versionState,
} = vi.hoisted(() => ({
  hookState: {
    settings: null as ServerSettings | null,
    isLoading: false,
    error: null as string | null,
  },
  mockDisconnect: vi.fn(),
  mockGetFileAccessInfo: vi.fn(),
  mockUpdateSetting: vi.fn(),
  mockUpdateSettings: vi.fn(),
  remoteState: {
    connection: null as null | { disconnect: () => void },
  },
  versionState: {
    capabilities: [] as string[],
  },
}));

vi.mock("../../../api/client", async () => {
  const actual = await vi.importActual<typeof import("../../../api/client")>(
    "../../../api/client",
  );
  return {
    ...actual,
    api: {
      ...actual.api,
      getFileAccessInfo: mockGetFileAccessInfo,
    },
  };
});

vi.mock("../../../contexts/AuthContext", () => ({
  useOptionalAuth: () => null,
}));

vi.mock("../../../contexts/RemoteConnectionContext", () => ({
  useOptionalRemoteConnection: () => remoteState.connection,
}));

vi.mock("../../../hooks/useNetworkBinding", () => ({
  useNetworkBinding: () => ({
    binding: null,
    loading: false,
    applying: false,
    updateBinding: vi.fn(),
  }),
}));

vi.mock("../../../hooks/useServerInfo", () => ({
  useServerInfo: () => ({
    serverInfo: null,
    loading: false,
  }),
}));

vi.mock("../../../hooks/useServerSettings", () => ({
  useServerSettings: () => ({
    ...hookState,
    updateSetting: mockUpdateSetting,
    updateSettings: mockUpdateSettings,
    refetch: vi.fn(),
  }),
}));

vi.mock("../../../hooks/useVersion", () => ({
  useVersion: () => ({
    version: {
      capabilities: versionState.capabilities,
    },
  }),
}));

vi.mock("../../../i18n", () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}));

const fileAccessInfo: FileAccessInfo = {
  envPinned: false,
  envPaths: [],
  tempPaths: ["/tmp"],
  uploadsDir: "/uploads",
  homeDir: "/home/alice",
};

const baseFileAccess: FileAccessSettings = {
  projects: true,
  uploads: true,
  temp: true,
  home: false,
  custom: [],
};

const baseSettings: ServerSettings = {
  serviceWorkerEnabled: true,
  persistRemoteSessionsToDisk: false,
  fileAccess: baseFileAccess,
};

function checkboxFor(labelKey: string): HTMLInputElement {
  return screen.getByRole("checkbox", {
    name: labelKey,
  }) as HTMLInputElement;
}

describe("LocalAccessSettings", () => {
  beforeEach(() => {
    hookState.settings = {
      ...baseSettings,
      fileAccess: {
        ...baseFileAccess,
        custom: [...baseFileAccess.custom],
      },
    };
    hookState.isLoading = false;
    hookState.error = null;
    remoteState.connection = { disconnect: mockDisconnect };
    mockGetFileAccessInfo.mockResolvedValue(fileAccessInfo);
    mockUpdateSetting.mockResolvedValue(undefined);
    mockUpdateSettings.mockImplementation(
      async (updates: Partial<ServerSettings>) => {
        if (!hookState.settings) throw new Error("settings not initialized");
        hookState.settings = { ...hookState.settings, ...updates };
      },
    );
    versionState.capabilities = [APPROVAL_AUDIT_LOG_CAPABILITY];
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    remoteState.connection = null;
  });

  it("shows file access controls in relay mode without direct port controls", async () => {
    render(<LocalAccessSettings />);

    const fileAccessPanel = await screen.findByRole("group", {
      name: "fileAccessTitle",
    });
    expect(fileAccessPanel.contains(screen.getByText("fileAccessHome"))).toBe(
      true,
    );
    expect(screen.queryByText("developmentRelayDebugTitle")).toBeNull();
    expect(screen.queryByText("localAccessRelayDebugTitle")).toBeNull();
    expect(screen.queryByText("localAccessListeningPortTitle")).toBeNull();
  });

  it("saves relay-mode file access toggles immediately", async () => {
    render(<LocalAccessSettings />);

    fireEvent.click(checkboxFor("fileAccessHome"));

    await waitFor(() =>
      expect(mockUpdateSettings).toHaveBeenCalledWith({
        fileAccess: {
          projects: true,
          uploads: true,
          temp: true,
          home: true,
          custom: [],
        },
      }),
    );
    expect(
      screen.queryByRole("button", { name: "localAccessApply" }),
    ).toBeNull();
  });

  it("saves custom folders on blur or explicit save", async () => {
    render(<LocalAccessSettings />);

    const customFolders = await screen.findByRole("textbox", {
      name: "fileAccessCustomTitle",
    });
    fireEvent.change(customFolders, {
      target: { value: " /srv/first \n/srv/second" },
    });
    fireEvent.blur(customFolders);

    await waitFor(() =>
      expect(mockUpdateSettings).toHaveBeenLastCalledWith({
        fileAccess: {
          projects: true,
          uploads: true,
          temp: true,
          home: false,
          custom: ["/srv/first", "/srv/second"],
        },
      }),
    );

    fireEvent.change(customFolders, {
      target: { value: "/srv/clicked" },
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "fileAccessCustomSave" }),
    );

    await waitFor(() =>
      expect(mockUpdateSettings).toHaveBeenLastCalledWith({
        fileAccess: {
          projects: true,
          uploads: true,
          temp: true,
          home: false,
          custom: ["/srv/clicked"],
        },
      }),
    );
  });

  it("undoes an immediately saved custom folder edit", async () => {
    let undoRegistration: SettingsUndoRegistration | null = null;
    render(
      <SettingsUndoProvider
        value={(registration) => {
          undoRegistration = registration;
        }}
      >
        <LocalAccessSettings />
      </SettingsUndoProvider>,
    );

    const customFolders = await screen.findByRole("textbox", {
      name: "fileAccessCustomTitle",
    });
    fireEvent.change(customFolders, {
      target: { value: "/srv/undo-me" },
    });
    fireEvent.blur(customFolders);

    await waitFor(() => expect(undoRegistration?.canUndo).toBe(true));
    const undo = (undoRegistration as SettingsUndoRegistration | null)?.undo;
    expect(undo).toBeTypeOf("function");
    await act(async () => {
      await undo?.();
    });

    await waitFor(() =>
      expect(mockUpdateSettings).toHaveBeenLastCalledWith({
        fileAccess: baseFileAccess,
      }),
    );
  });

  it("updates approval audit logging when the server supports it", async () => {
    hookState.settings = {
      ...baseSettings,
      approvalAuditLogEnabled: false,
    };

    render(<LocalAccessSettings />);

    const auditToggle = await screen.findByRole("checkbox", {
      name: "localAccessApprovalAuditTitle",
    });
    expect(auditToggle).toHaveProperty("disabled", false);
    expect(auditToggle).toHaveProperty("checked", false);

    fireEvent.click(auditToggle);

    expect(mockUpdateSetting).toHaveBeenCalledWith(
      "approvalAuditLogEnabled",
      true,
    );
  });

  it("shows legacy approval audit logging as read-only without capability", async () => {
    versionState.capabilities = [];
    hookState.settings = {
      ...baseSettings,
      approvalAuditLogEnabled: false,
    };

    render(<LocalAccessSettings />);

    const auditToggle = await screen.findByRole("checkbox", {
      name: "localAccessApprovalAuditTitle",
    });
    expect(auditToggle).toHaveProperty("disabled", true);
    expect(auditToggle).toHaveProperty("checked", true);
    expect(
      screen.getByText("localAccessApprovalAuditUnsupportedDescription"),
    ).toBeTruthy();
  });
});
