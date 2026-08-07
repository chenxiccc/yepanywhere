// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  PROJECT_QUEUE_CAPABILITY,
  SESSION_SANDBOXING_CAPABILITY,
  SESSION_SANDBOXING_STATUS_CAPABILITY,
} from "@yep-anywhere/shared";
import {
  Fragment,
  forwardRef,
  useCallback,
  useImperativeHandle,
  useMemo,
  useState,
} from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  YA_GROK_BATCH_SPEECH_METHOD,
  XAI_DIRECT_STREAMING_SPEECH_METHOD,
} from "../../lib/speechProviders/methods";
import { UI_KEYS } from "../../lib/storageKeys";
import { NewSessionForm } from "../NewSessionForm";

const {
  mockNavigate,
  mockRefetchProviders,
  mockRefreshProviderRow,
  mockUpdateSetting,
  mockStartSession,
  mockStartDetachedSession,
  mockCreateSession,
  mockCreateDetachedSession,
  mockQueueMessage,
  mockCreateProjectQueueItem,
  mockGetProjectWorkstreams,
  mockReportProjectQueueCollectionSnapshot,
  mockAddProject,
  mockUpload,
  mockUploadStagedAttachment,
  mockConnectionFetch,
  mockCycleThinkingMode,
  mockSetEffortLevel,
  mockSetShowThinking,
  mockSetSpeechMethod,
  mockSetSpeechSmartTurnSettings,
  mockSetGrokSpeechAudioSettings,
  mockVoiceToggle,
  mockVoiceCancelProcessing,
  mockVoiceContinueAfterSpeechSend,
  voicePropsState,
  draftKeys,
  modelSettingsState,
  providersState,
  providerRowState,
  serverSettingsState,
  versionState,
  remoteBasePathState,
  filterDropdownState,
  toolbarVisibilityState,
  inboxState,
  projectQueueState,
  draftAttachmentState,
} = vi.hoisted(() => ({
  mockNavigate: vi.fn(),
  mockRefetchProviders: vi.fn(),
  mockRefreshProviderRow: vi.fn(),
  mockUpdateSetting: vi.fn(),
  mockStartSession: vi.fn(),
  mockStartDetachedSession: vi.fn(),
  mockCreateSession: vi.fn(),
  mockCreateDetachedSession: vi.fn(),
  mockQueueMessage: vi.fn(),
  mockCreateProjectQueueItem: vi.fn(),
  mockGetProjectWorkstreams: vi.fn(),
  mockReportProjectQueueCollectionSnapshot: vi.fn(),
  mockAddProject: vi.fn(),
  mockUpload: vi.fn(),
  mockUploadStagedAttachment: vi.fn(),
  mockConnectionFetch: vi.fn(),
  mockCycleThinkingMode: vi.fn(),
  mockSetEffortLevel: vi.fn(),
  mockSetShowThinking: vi.fn(),
  mockSetSpeechMethod: vi.fn(),
  mockSetSpeechSmartTurnSettings: vi.fn(),
  mockSetGrokSpeechAudioSettings: vi.fn(),
  mockVoiceToggle: vi.fn(),
  mockVoiceCancelProcessing: vi.fn(),
  mockVoiceContinueAfterSpeechSend: vi.fn(),
  voicePropsState: {
    current: null as null | {
      onPendingSpeechChange?: (
        kind: "starting" | "listening" | "transcribing" | "finalizing" | null,
        settlement?: "completed" | "failed",
      ) => void;
      onInterimTranscript?: (text: string) => void;
      onTranscript?: (
        text: string,
        metadata?: {
          smartTurnCommand?: "cancel" | "send" | "wait";
          smartTurnAutoSend?: boolean;
        },
      ) => void;
      onListeningStart?: () => void;
      onListeningStop?: () => boolean | undefined;
    },
  },
  draftKeys: [] as string[],
  modelSettingsState: {
    thinkingMode: "off" as "off" | "auto" | "on",
    effortLevel: "high" as "low" | "medium" | "high" | "max",
    voiceInputEnabled: true,
    speechMethod: "browser-native",
    hasStoredSpeechMethod: false,
    speechSmartTurnSettings: {
      enabled: false,
      threshold: 0.95,
      timeoutMs: 3000,
    },
    grokSpeechAudioSettings: {
      uplinkMode: "pcm16" as "pcm16" | "browser-compressed",
    },
  },
  providersState: {
    providers: [] as Array<{
      name: string;
      displayName: string;
      installed: boolean;
      authenticated: boolean;
      enabled?: boolean;
      supportsPermissionMode?: boolean;
      supportsThinkingToggle?: boolean;
      supportsRecaps?: boolean;
      supportsNativeRecaps?: boolean;
      supportsNativePromptSuggestions?: boolean;
      models?: Array<{
        id: string;
        name: string;
        description?: string;
        catalogGroup?: "additional";
        supportsAdaptiveThinking?: boolean;
        supportsEffort?: boolean;
        supportedEffortLevels?: Array<
          "low" | "medium" | "high" | "xhigh" | "max"
        >;
        supportsAutoMode?: boolean;
      }>;
    }>,
    loading: false,
  },
  providerRowState: {
    fresh: true,
    refreshing: false,
    error: null as Error | null,
  },
  serverSettingsState: {
    settings: null as {
      newSessionDefaults?: {
        provider?: "claude" | "claude-gateway" | "codex" | "opencode";
        model?: string;
        permissionMode?: "default" | "auto";
        recapMode?: "off" | "native" | "side-session" | "fork";
        recapAfterSeconds?: number;
        promptSuggestionMode?: "off" | "native";
        sandboxLevel?: "none" | "project-write";
        helperSideModel?: string;
        providers?: Partial<
          Record<
            "claude" | "claude-gateway" | "codex",
            {
              model?: string;
              thinkingMode?: "off" | "auto" | "on";
              effortLevel?: "low" | "medium" | "high" | "xhigh" | "max";
              helperSideModel?: string;
            }
          >
        >;
      };
      helperTargets?: Array<{
        id: string;
        name: string;
        kind: "openai-compatible";
        baseUrl: string;
        model?: string;
      }>;
      workstreamsEnabled?: boolean;
    } | null,
    isLoading: true,
  },
  versionState: {
    version: null as {
      capabilities?: string[];
      sessionSandboxing?: {
        state:
          | "available"
          | "unsupported-platform"
          | "missing-bubblewrap"
          | "untrusted-bubblewrap"
          | "unsupported-version"
          | "probe-failed";
        platform: string;
        backend?: "bubblewrap";
        version?: string;
      };
      voiceBackends?: string[];
      voiceBackendCapabilities?: Record<
        string,
        { streaming?: boolean; smartTurn?: boolean }
      >;
      clientDefaults?: {
        projectQueueCtrlEnterEnabled?: boolean;
      };
    } | null,
  },
  remoteBasePathState: {
    basePath: "",
  },
  filterDropdownState: {
    selected: [] as string[],
  },
  toolbarVisibilityState: {
    projectQueue: false,
  },
  inboxState: {
    needsAttention: [] as Array<{ sessionId: string; projectId: string }>,
    active: [] as Array<{ sessionId: string; projectId: string }>,
  },
  projectQueueState: {
    byProject: {} as Record<string, unknown[]>,
  },
  draftAttachmentState: {
    value: null as null | {
      batchId: string;
      refs: Array<{
        id: string;
        batchId: string;
        originalName: string;
        name: string;
        size: number;
        mimeType: string;
        width?: number;
        height?: number;
        createdAt: string;
        updatedAt: string;
      }>;
      updatedAt: string;
    },
  },
}));

const coarsePointerState = vi.hoisted(() => ({ current: false }));

vi.mock("../../lib/deviceDetection", () => ({
  hasCoarsePointer: () => coarsePointerState.current,
}));

vi.mock("react-router-dom", async () => {
  const actual =
    await vi.importActual<typeof import("react-router-dom")>(
      "react-router-dom",
    );

  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

vi.mock("../../api/client", () => ({
  api: {
    addProject: mockAddProject,
    startSession: mockStartSession,
    startDetachedSession: mockStartDetachedSession,
    createDetachedSession: mockCreateDetachedSession,
    createSession: mockCreateSession,
    queueMessage: mockQueueMessage,
    createProjectQueueItem: mockCreateProjectQueueItem,
    getProjectWorkstreams: mockGetProjectWorkstreams,
  },
}));

vi.mock("../../hooks/useDraftPersistence", () => ({
  useDraftPersistence: (key: string) => {
    draftKeys.push(key);
    const [value, setValue] = useState("");
    const getDraft = useCallback(() => value, [value]);
    const setDraft = useCallback(
      (nextValue: string) => setValue(nextValue),
      [],
    );
    const getAttachmentState = useCallback(
      () => draftAttachmentState.value,
      [],
    );
    const setAttachmentState = useCallback(
      (nextValue: typeof draftAttachmentState.value) => {
        draftAttachmentState.value = nextValue;
      },
      [],
    );
    const flushDraft = useCallback(() => {}, []);
    const clearInput = useCallback(() => setValue(""), []);
    const clearDraft = useCallback(() => {
      setValue("");
      draftAttachmentState.value = null;
    }, []);
    const restoreFromStorage = useCallback(() => {}, []);

    const controls = useMemo(
      () => ({
        getDraft,
        getAttachmentState,
        setDraft,
        setAttachmentState,
        flushDraft,
        clearInput,
        clearDraft,
        restoreFromStorage,
      }),
      [
        clearDraft,
        clearInput,
        flushDraft,
        getAttachmentState,
        getDraft,
        restoreFromStorage,
        setAttachmentState,
        setDraft,
      ],
    );

    return [value, setValue, controls] as const;
  },
}));

vi.mock("../../hooks/useModelSettings", () => ({
  useModelSettings: () => ({
    effortLevel: modelSettingsState.effortLevel,
    setEffortLevel: mockSetEffortLevel,
    thinkingMode: modelSettingsState.thinkingMode,
    cycleThinkingMode: mockCycleThinkingMode,
    setThinkingMode: vi.fn(),
    thinkingLevel: modelSettingsState.effortLevel,
    showThinking: "default",
    setShowThinking: mockSetShowThinking,
    voiceInputEnabled: modelSettingsState.voiceInputEnabled,
    speechMethod: modelSettingsState.speechMethod,
    hasStoredSpeechMethod: modelSettingsState.hasStoredSpeechMethod,
    setSpeechMethod: mockSetSpeechMethod,
    speechSmartTurnSettings: modelSettingsState.speechSmartTurnSettings,
    setSpeechSmartTurnSettings: mockSetSpeechSmartTurnSettings,
    grokSpeechAudioSettings: modelSettingsState.grokSpeechAudioSettings,
    setGrokSpeechAudioSettings: mockSetGrokSpeechAudioSettings,
  }),
  getThinkingSetting: () =>
    modelSettingsState.thinkingMode === "off"
      ? "off"
      : modelSettingsState.thinkingMode === "auto"
        ? "auto"
        : `on:${modelSettingsState.effortLevel}`,
  getModelSetting: () => "opus",
  getShowThinkingSetting: () => "default",
  EFFORT_LEVEL_OPTIONS: [
    { value: "low", label: "Low", description: "Fastest responses" },
    { value: "medium", label: "Medium", description: "Moderate thinking" },
    { value: "high", label: "High", description: "Deep reasoning" },
    { value: "max", label: "Max", description: "Maximum effort" },
  ],
}));

vi.mock("../../hooks/useProviders", () => ({
  useProviders: () => ({
    ...providersState,
    error: null,
    refetch: mockRefetchProviders,
    reload: vi.fn(),
  }),
  useProviderRow: (providerName: string | null | undefined) => ({
    row:
      providersState.providers.find(
        (provider) => provider.name === providerName,
      ) ?? null,
    loading:
      providerRowState.refreshing &&
      !providersState.providers.some(
        (provider) => provider.name === providerName,
      ),
    refreshing: providerRowState.refreshing,
    fresh: providerRowState.fresh,
    error: providerRowState.error,
    refresh: mockRefreshProviderRow,
  }),
  getAvailableProviders: (providers: typeof providersState.providers) =>
    providers.filter(
      (provider) => provider.installed && provider.authenticated,
    ),
  getDefaultProvider: (providers: typeof providersState.providers) =>
    providers.find((provider) => provider.name === "claude") ??
    providers[0] ??
    null,
}));

vi.mock("../../hooks/useRemoteBasePath", () => ({
  useRemoteBasePath: () => remoteBasePathState.basePath,
}));

vi.mock("../../hooks/useRemoteExecutors", () => ({
  useRemoteExecutors: () => ({
    executors: [],
    loading: false,
  }),
}));

vi.mock("../../hooks/useServerSettings", () => ({
  useServerSettings: () => ({
    settings: serverSettingsState.settings,
    isLoading: serverSettingsState.isLoading,
    error: null,
    updateSettings: vi.fn(),
    updateSetting: mockUpdateSetting,
    refetch: vi.fn(),
  }),
}));

vi.mock("../../hooks/useSessionToolbarPresence", () => ({
  useSessionToolbarPresence: () => ({
    visibility: {
      projectQueue: toolbarVisibilityState.projectQueue,
    },
  }),
}));

vi.mock("../../lib/clientSummaryStore", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../lib/clientSummaryStore")>();
  return {
    ...actual,
    reportProjectQueueCollectionSnapshot:
      mockReportProjectQueueCollectionSnapshot,
    useClientSummarySourceKey: () => "host:test",
    useActiveProjectSessionIds: (projectId: string | null | undefined) => {
      if (!projectId) return [];
      return [...inboxState.needsAttention, ...inboxState.active]
        .filter((item) => item.projectId === projectId)
        .map((item) => item.sessionId);
    },
  };
});

vi.mock("../../contexts/SourceRuntimeContext", () => ({
  useCurrentSourceRuntime: () => ({
    sourceKey: "host:test",
    transport: {
      capabilities: { sameOriginUrls: true },
      fetch: mockConnectionFetch,
      upload: mockUpload,
      uploadStagedAttachment: mockUploadStagedAttachment,
    },
    summary: {
      reportProjectQueueCollectionSnapshot:
        mockReportProjectQueueCollectionSnapshot,
    },
  }),
}));

vi.mock("../../hooks/useProjectQueues", () => ({
  useProjectQueues: (projectIds: string[]) => {
    const queuesByProject = Object.fromEntries(
      projectIds.map((projectId) => [
        projectId,
        projectQueueState.byProject[projectId] ?? [],
      ]),
    );
    return {
      queuesByProject,
      items: Object.values(queuesByProject).flat(),
      projectStatusesByProject: {},
      recoveredSessionQueues: [],
      loading: false,
      error: null,
      mutatingItemId: null,
      mutatingDispatchState: false,
      mutatingPromoteItemId: null,
      dispatchState: { status: "running" },
      refetch: vi.fn(),
      pauseDispatch: vi.fn(),
      resumeDispatch: vi.fn(),
      promoteNow: vi.fn(),
      updateItem: vi.fn(),
      deleteItem: vi.fn(),
      retryItem: vi.fn(),
      moveItemToTop: vi.fn(),
    };
  },
}));

vi.mock("../../hooks/useVersion", () => ({
  useVersion: () => ({
    version: versionState.version,
    loading: false,
    error: null,
    refetch: vi.fn(),
    refetchFresh: vi.fn(),
  }),
}));

vi.mock("../../contexts/ToastContext", () => ({
  useToastContext: () => ({
    showToast: vi.fn(),
  }),
}));

vi.mock("../../i18n", () => ({
  useI18n: () => ({
    t: (key: string, vars?: Record<string, string | number>) => {
      const text: Record<string, string> = {
        effortLevelLowLabel: "Low",
        effortLevelMediumLabel: "Medium",
        effortLevelHighLabel: "High",
        effortLevelExtraLabel: "Extra",
        effortLevelExtraHighLabel: "Extra High",
        effortLevelMaxLabel: "Max",
        effortLevelLowDescription: "Fastest responses",
        effortLevelMediumDescription: "Moderate reasoning",
        effortLevelHighDescription: "Deep reasoning",
        effortLevelExtraDescription: "For your hardest tasks",
        effortLevelExtraHighDescription: "Extra-high reasoning",
        effortLevelMaxDescription: "Maximum effort",
        recapModeSideSessionTimedDescription:
          "Summarize tailed assistant output after backgrounding (not closing) for {seconds} s.",
        recapModeForkTimedDescription:
          "Summarize from a temporary fork after backgrounding (not closing) for {seconds} s.",
        toolbarProjectQueueTooltipWithShortcut:
          "Send after all sessions in this project are idle\nCtrl+Enter",
        speechPrefixDeliveryLabel: "{action}. Prepends {prefix}.",
        speechPrefixDeliveryTooltip: "{tooltip} Prepends {prefix}.",
      };
      let translated = text[key] ?? key;
      if (!vars) return translated;
      for (const [name, value] of Object.entries(vars)) {
        translated = translated.replaceAll(`{${name}}`, String(value));
      }
      return translated;
    },
  }),
}));

vi.mock("../FilterDropdown", () => ({
  FilterDropdown: ({
    options,
    selected,
    onChange,
  }: {
    options: Array<{
      value: string;
      label: string;
      groupLabelBefore?: string;
    }>;
    selected: string[];
    onChange: (selected: string[]) => void;
  }) => {
    filterDropdownState.selected = selected;
    return (
      <div>
        <div data-testid="filter-selected">{selected[0] ?? ""}</div>
        {options.map((option) => (
          <Fragment key={option.value}>
            {option.groupLabelBefore && <p>{option.groupLabelBefore}</p>}
            <button type="button" onClick={() => onChange([option.value])}>
              {option.label}
            </button>
          </Fragment>
        ))}
      </div>
    );
  },
}));

vi.mock("../../lib/newSessionPrefill", () => ({
  clearNewSessionPrefill: vi.fn(),
  getNewSessionPrefill: () => "",
}));

vi.mock("../VoiceInputButton", () => ({
  VoiceInputButton: forwardRef((props: Record<string, unknown>, ref) => {
    voicePropsState.current = props as typeof voicePropsState.current;
    useImperativeHandle(
      ref,
      () => ({
        stopAndFinalize: () => "",
        toggle: mockVoiceToggle,
        cancelProcessing: mockVoiceCancelProcessing,
        beginInsertionBoundary: vi.fn(),
        continueAfterSpeechSend: mockVoiceContinueAfterSpeechSend,
        isListening: false,
        isAvailable: true,
      }),
      [],
    );
    return <button type="button">voice</button>;
  }),
}));

const chooserProjects = [
  {
    id: "project-1",
    name: "Alpha",
    path: "/tmp/alpha",
    sessionCount: 3,
    activeOwnedCount: 0,
    activeExternalCount: 0,
    lastActivity: "2026-04-23T10:00:00.000Z",
  },
  {
    id: "project-2",
    name: "Beta",
    path: "/tmp/beta",
    sessionCount: 1,
    activeOwnedCount: 0,
    activeExternalCount: 0,
    lastActivity: "2026-04-22T10:00:00.000Z",
  },
] as const;

const stagedRef = {
  id: "staged-file-1",
  batchId: "batch-new-session",
  originalName: "notes.txt",
  name: "staged-file-1_notes.txt",
  size: 5,
  mimeType: "text/plain",
  createdAt: "2026-06-28T00:00:00.000Z",
  updatedAt: "2026-06-28T00:00:00.000Z",
};

const materializedFile = {
  id: "staged-file-1",
  originalName: "notes.txt",
  name: "staged-file-1_notes.txt",
  path: "/tmp/alpha/.attachments/session-created/staged-file-1_notes.txt",
  size: 5,
  mimeType: "text/plain",
};

function installObjectUrlMock() {
  const URLCtor = URL;
  class MockURL extends URLCtor {}
  Object.defineProperty(MockURL, "createObjectURL", {
    configurable: true,
    value: vi.fn(() => "blob:new-session-attachment"),
  });
  Object.defineProperty(MockURL, "revokeObjectURL", {
    configurable: true,
    value: vi.fn(),
  });
  vi.stubGlobal("URL", MockURL);
}

describe("NewSessionForm", () => {
  beforeEach(() => {
    coarsePointerState.current = false;
    installObjectUrlMock();
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    );
    providersState.providers = [
      {
        name: "claude",
        displayName: "Claude",
        installed: true,
        authenticated: true,
        supportsPermissionMode: true,
        supportsThinkingToggle: true,
        supportsRecaps: true,
        supportsNativePromptSuggestions: true,
        models: [
          { id: "default", name: "Default" },
          { id: "opus", name: "Opus 4.8" },
        ],
      },
      {
        name: "codex",
        displayName: "Codex",
        installed: true,
        authenticated: true,
        supportsPermissionMode: true,
        supportsThinkingToggle: true,
        supportsRecaps: true,
        supportsNativePromptSuggestions: false,
        models: [
          { id: "gpt-5.4", name: "GPT-5.4" },
          { id: "gpt-5.3-codex", name: "GPT-5.3-Codex" },
        ],
      },
    ];
    providersState.loading = false;
    providerRowState.fresh = true;
    providerRowState.refreshing = false;
    providerRowState.error = null;
    serverSettingsState.settings = null;
    serverSettingsState.isLoading = true;
    filterDropdownState.selected = [];
    toolbarVisibilityState.projectQueue = false;
    inboxState.needsAttention = [];
    inboxState.active = [];
    projectQueueState.byProject = {};
    modelSettingsState.thinkingMode = "off";
    modelSettingsState.effortLevel = "high";
    mockNavigate.mockReset();
    mockRefetchProviders.mockReset();
    mockRefetchProviders.mockResolvedValue(undefined);
    mockRefreshProviderRow.mockReset();
    mockRefreshProviderRow.mockResolvedValue(undefined);
    mockUpdateSetting.mockReset();
    mockStartSession.mockReset();
    mockStartDetachedSession.mockReset();
    mockCreateSession.mockReset();
    mockCreateDetachedSession.mockReset();
    mockQueueMessage.mockReset();
    mockCreateProjectQueueItem.mockReset();
    mockGetProjectWorkstreams.mockReset();
    mockAddProject.mockReset();
    mockUpload.mockReset();
    mockUploadStagedAttachment.mockReset();
    mockConnectionFetch.mockReset();
    mockCycleThinkingMode.mockReset();
    mockSetEffortLevel.mockReset();
    mockSetShowThinking.mockReset();
    mockSetSpeechMethod.mockReset();
    mockSetSpeechSmartTurnSettings.mockReset();
    mockSetGrokSpeechAudioSettings.mockReset();
    mockVoiceToggle.mockReset();
    mockVoiceCancelProcessing.mockReset();
    mockVoiceContinueAfterSpeechSend.mockReset();
    voicePropsState.current = null;
    draftKeys.length = 0;
    draftAttachmentState.value = null;
    remoteBasePathState.basePath = "";
    versionState.version = { capabilities: [PROJECT_QUEUE_CAPABILITY] };
    modelSettingsState.voiceInputEnabled = true;
    modelSettingsState.speechMethod = "browser-native";
    modelSettingsState.hasStoredSpeechMethod = false;
    modelSettingsState.speechSmartTurnSettings = {
      enabled: false,
      threshold: 0.95,
      timeoutMs: 3000,
    };
    modelSettingsState.grokSpeechAudioSettings = {
      uplinkMode: "pcm16",
    };
    mockStartSession.mockResolvedValue({
      sessionId: "session-1",
      processId: "process-1",
      projectId: "project-1",
      permissionMode: "default",
      modeVersion: 0,
    });
    mockStartDetachedSession.mockResolvedValue({
      sessionId: "session-detached",
      processId: "process-detached",
      projectId: "detached-project",
      permissionMode: "default",
      modeVersion: 0,
    });
    mockCreateSession.mockResolvedValue({
      sessionId: "session-created",
      processId: "process-created",
      projectId: "project-1",
      permissionMode: "default",
      modeVersion: 0,
      serverTimestamp: 1000,
    });
    mockCreateDetachedSession.mockResolvedValue({
      sessionId: "session-detached-created",
      processId: "process-detached-created",
      projectId: "detached-project",
      permissionMode: "default",
      modeVersion: 0,
      serverTimestamp: 1000,
    });
    mockQueueMessage.mockResolvedValue({
      serverTimestamp: 1001,
    });
    mockCreateProjectQueueItem.mockResolvedValue({
      item: {
        id: "queue-1",
        projectId: "project-1",
        target: { type: "new-session" },
        messagePreview: "Queued work",
        message: { text: "Queued work" },
        createdAt: "2026-06-27T00:00:00.000Z",
        updatedAt: "2026-06-27T00:00:00.000Z",
        status: "queued",
        attachmentCount: 0,
      },
      queue: { projectId: "project-1", items: [] },
    });
    mockGetProjectWorkstreams.mockResolvedValue({
      projectId: "project-1",
      workstreams: [],
    });
    mockAddProject.mockResolvedValue({
      project: {
        id: "project-added",
        name: "added-project",
        path: "/tmp/added-project",
        sessionCount: 0,
        activeOwnedCount: 0,
        activeExternalCount: 0,
        lastActivity: null,
      },
    });
    window.localStorage.setItem(UI_KEYS.speechMessagePrefixMode, "asr");
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps an explicit Claude selection when saved Codex defaults load later", async () => {
    const { rerender } = render(<NewSessionForm projectId="project-1" />);

    fireEvent.click(screen.getByRole("button", { name: "Claude" }));

    expect(screen.getByRole("button", { name: "Claude" }).className).toContain(
      "selected",
    );
    expect(screen.getAllByTestId("filter-selected")[0]!.textContent).toBe(
      "opus",
    );

    serverSettingsState.settings = {
      newSessionDefaults: {
        provider: "codex",
        model: "gpt-5.3-codex",
        permissionMode: "default",
      },
    };
    serverSettingsState.isLoading = false;

    rerender(<NewSessionForm projectId="project-1" />);

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Claude" }).className,
      ).toContain("selected");
      expect(
        screen.getByRole("button", { name: "Codex" }).className,
      ).not.toContain("selected");
      expect(screen.getAllByTestId("filter-selected")[0]!.textContent).toBe(
        "opus",
      );
    });
  });

  it("does not reuse the Claude fallback model when switching to Codex", async () => {
    serverSettingsState.isLoading = false;

    render(
      <NewSessionForm
        projectId="project-1"
        selectedProject={chooserProjects[0]}
        projects={[...chooserProjects]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Codex" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Codex" }).className).toContain(
        "selected",
      );
      expect(screen.getAllByTestId("filter-selected")[0]!.textContent).toBe(
        "gpt-5.4",
      );
    });
  });

  it("restores provider-scoped model and thinking defaults on provider switch", async () => {
    serverSettingsState.settings = {
      newSessionDefaults: {
        provider: "claude",
        permissionMode: "default",
        providers: {
          claude: {
            model: "opus",
            thinkingMode: "on",
            effortLevel: "medium",
          },
          codex: {
            model: "gpt-5.3-codex",
            thinkingMode: "auto",
            effortLevel: "xhigh",
          },
        },
      },
    };
    serverSettingsState.isLoading = false;

    render(
      <NewSessionForm
        projectId="project-1"
        selectedProject={chooserProjects[0]}
        projects={[...chooserProjects]}
      />,
    );

    await waitFor(() => {
      expect(screen.getAllByTestId("filter-selected")[0]!.textContent).toBe(
        "opus",
      );
      expect(screen.getByRole("radio", { name: "Medium" }).className).toContain(
        "active",
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Codex" }));

    await waitFor(() => {
      expect(screen.getAllByTestId("filter-selected")[0]!.textContent).toBe(
        "gpt-5.3-codex",
      );
      expect(
        screen.getByRole("radio", { name: "modelSettingsThinkingAutoLabel" })
          .className,
      ).toContain("active");
    });

    fireEvent.click(screen.getByRole("button", { name: "Claude" }));

    await waitFor(() => {
      expect(screen.getAllByTestId("filter-selected")[0]!.textContent).toBe(
        "opus",
      );
      expect(screen.getByRole("radio", { name: "Medium" }).className).toContain(
        "active",
      );
    });
  });

  it("reuses new-session selection semantics for a seeded launch", async () => {
    const submit = vi.fn(async () => {});
    const codexProvider = providersState.providers.find(
      (candidate) => candidate.name === "codex",
    );
    const seededCodexModel = codexProvider?.models?.find(
      (model) => model.id === "gpt-5.3-codex",
    );
    if (!seededCodexModel) throw new Error("expected Codex model fixture");
    seededCodexModel.supportsAdaptiveThinking = true;
    seededCodexModel.supportsEffort = true;
    seededCodexModel.supportedEffortLevels = ["low", "high", "xhigh"];
    serverSettingsState.settings = {
      newSessionDefaults: {
        provider: "claude",
        permissionMode: "default",
        providers: {
          claude: {
            model: "default",
            thinkingMode: "off",
            effortLevel: "low",
          },
          codex: {
            model: "gpt-5.3-codex",
            thinkingMode: "auto",
            effortLevel: "xhigh",
          },
        },
      },
    };
    serverSettingsState.isLoading = false;

    render(
      <NewSessionForm
        projectId="project-1"
        selectedProject={chooserProjects[0]}
        preferredProvider="claude"
        preferredModel="opus"
        preferredThinking="on:xhigh"
        preferredPermissionMode="plan"
        preferredExecutor="build-host"
        launch={{
          draftKey: "draft-handoff:session-1",
          initialMessage: "Prepared handoff",
          fixedProject: true,
          allowAttachments: false,
          allowProjectQueue: false,
          submit,
        }}
      />,
    );

    const composer = await screen.findByDisplayValue("Prepared handoff");
    expect(draftKeys).toContain("draft-handoff:session-1");
    expect(screen.queryByLabelText("newSessionAttachFiles")).toBeNull();
    expect(screen.queryByText("Alpha")).toBeNull();
    expect(screen.getAllByTestId("filter-selected")[0]!.textContent).toBe(
      "opus",
    );

    fireEvent.click(screen.getByRole("button", { name: "Codex" }));

    await waitFor(() => {
      expect(screen.getAllByTestId("filter-selected")[0]!.textContent).toBe(
        "gpt-5.3-codex",
      );
      expect(
        screen.getByRole("radio", { name: "Extra High" }).className,
      ).toContain("active");
    });

    fireEvent.click(
      screen.getByRole("button", { name: "newSessionStartAction" }),
    );

    await waitFor(() => {
      expect(submit).toHaveBeenCalledWith({
        message: "Prepared handoff",
        options: expect.objectContaining({
          mode: "plan",
          model: "gpt-5.3-codex",
          thinking: "on:xhigh",
          provider: "codex",
          executor: "build-host",
        }),
        clientTimestamp: expect.any(Number),
      });
    });
    expect(mockStartSession).not.toHaveBeenCalled();
    expect((composer as HTMLTextAreaElement).value).toBe("");
  });

  it("groups previous models and keeps an unlisted saved default selected", async () => {
    const claudeProvider = providersState.providers[0];
    if (!claudeProvider) throw new Error("expected Claude provider fixture");
    providersState.providers[0] = {
      ...claudeProvider,
      models: [
        { id: "latest", name: "Latest" },
        {
          id: "previous",
          name: "Previous",
          catalogGroup: "additional",
        },
      ],
    };
    serverSettingsState.settings = {
      newSessionDefaults: {
        provider: "claude",
        permissionMode: "default",
        providers: {
          claude: { model: "removed-default" },
        },
      },
    };
    serverSettingsState.isLoading = false;

    render(
      <NewSessionForm
        projectId="project-1"
        selectedProject={chooserProjects[0]}
        projects={[...chooserProjects]}
      />,
    );

    await waitFor(() => {
      expect(screen.getAllByTestId("filter-selected")[0]!.textContent).toBe(
        "removed-default",
      );
    });
    expect(screen.getAllByText("previousModelsGroup").length).toBeGreaterThan(
      0,
    );
    expect(
      screen.getAllByRole("button", { name: "removed-default" }).length,
    ).toBeGreaterThan(0);
  });

  it("keeps stale Gateway models visible but blocked until named validation", async () => {
    providersState.providers.push({
      name: "claude-gateway",
      displayName: "Claude Gateway",
      installed: true,
      authenticated: true,
      enabled: true,
      supportsThinkingToggle: true,
      models: [{ id: "gpt-5.5", name: "Saved Gateway" }],
    });
    serverSettingsState.settings = {
      newSessionDefaults: {
        provider: "claude-gateway",
        permissionMode: "default",
        providers: {
          "claude-gateway": { model: "gpt-5.5" },
        },
      },
    };
    serverSettingsState.isLoading = false;
    providerRowState.fresh = false;
    providerRowState.refreshing = true;

    const { rerender } = render(
      <NewSessionForm
        projectId="project-1"
        selectedProject={chooserProjects[0]}
        projects={[...chooserProjects]}
      />,
    );

    expect(screen.getByText("newSessionGatewayCatalogLoading")).toBeDefined();
    expect(
      screen.getAllByRole("button", { name: "Saved Gateway" }).length,
    ).toBeGreaterThan(0);

    const composer = screen.getByPlaceholderText("newSessionPlaceholder");
    fireEvent.change(composer, { target: { value: "hello" } });
    expect(
      screen.getByRole("button", { name: "newSessionStartAction" }),
    ).toHaveProperty("disabled", true);
    fireEvent.keyDown(composer, { key: "Enter" });
    expect(mockStartSession).not.toHaveBeenCalled();

    providerRowState.refreshing = false;
    providerRowState.error = new Error("gateway unavailable");
    rerender(
      <NewSessionForm
        projectId="project-1"
        selectedProject={chooserProjects[0]}
        projects={[...chooserProjects]}
      />,
    );
    expect(
      screen.getByText("newSessionGatewayCatalogUnavailable"),
    ).toBeDefined();
    fireEvent.click(
      screen.getByRole("button", { name: "newSessionGatewayCatalogRetry" }),
    );
    expect(mockRefreshProviderRow).toHaveBeenCalledTimes(1);
    expect(mockRefetchProviders).not.toHaveBeenCalled();

    const gateway = providersState.providers.find(
      (provider) => provider.name === "claude-gateway",
    );
    if (!gateway) throw new Error("expected Claude Gateway provider fixture");
    gateway.models = [
      {
        id: "claude-opus-4-8",
        name: "Opus 4.8",
        supportsAdaptiveThinking: true,
        supportsEffort: true,
        supportedEffortLevels: ["low", "high", "xhigh"],
      },
    ];
    providerRowState.fresh = true;
    providerRowState.error = null;
    rerender(
      <NewSessionForm
        projectId="project-1"
        selectedProject={chooserProjects[0]}
        projects={[...chooserProjects]}
      />,
    );

    await waitFor(() => {
      expect(screen.getAllByTestId("filter-selected")[0]!.textContent).toBe(
        "claude-opus-4-8",
      );
    });
    expect(
      screen.queryByText("newSessionGatewayCatalogUnavailable"),
    ).toBeNull();
    expect(screen.getByRole("radio", { name: "Low" })).toBeDefined();
    expect(
      screen.getByRole("button", { name: "newSessionStartAction" }),
    ).toHaveProperty("disabled", false);
  });

  it("preserves Auto as the all-provider permission default across unsupported providers", async () => {
    const claudeProvider = providersState.providers[0];
    if (!claudeProvider) throw new Error("expected Claude provider fixture");
    providersState.providers[0] = {
      ...claudeProvider,
      models: [
        { id: "fable", name: "Fable", supportsAutoMode: true },
        { id: "opus", name: "Opus 4.8" },
      ],
    };
    serverSettingsState.settings = {
      newSessionDefaults: {
        provider: "claude",
        permissionMode: "auto",
        providers: {
          claude: { model: "fable" },
          codex: { model: "gpt-5.3-codex" },
        },
      },
    };
    serverSettingsState.isLoading = false;

    render(
      <NewSessionForm
        projectId="project-1"
        selectedProject={chooserProjects[0]}
        projects={[...chooserProjects]}
      />,
    );

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /modeAutoLabel/ }).className,
      ).toContain("selected");
    });

    fireEvent.click(screen.getByRole("button", { name: "Codex" }));

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /modeDefaultLabel/ }).className,
      ).toContain("selected");
      expect(mockUpdateSetting).toHaveBeenCalledWith(
        "newSessionDefaults",
        expect.objectContaining({
          provider: "codex",
          permissionMode: "auto",
        }),
      );
    });

    fireEvent.change(screen.getByPlaceholderText("newSessionPlaceholder"), {
      target: { value: "hello" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "newSessionStartAction" }),
    );

    await waitFor(() => {
      expect(mockStartSession).toHaveBeenCalledWith(
        "project-1",
        "hello",
        expect.objectContaining({
          provider: "codex",
          mode: "default",
        }),
        undefined,
        expect.any(Number),
      );
    });
  });

  it("submits the selected Claude provider and model to startSession", async () => {
    serverSettingsState.settings = {
      newSessionDefaults: {
        provider: "codex",
        model: "gpt-5.3-codex",
        permissionMode: "default",
      },
    };
    serverSettingsState.isLoading = false;

    render(
      <NewSessionForm
        projectId="project-1"
        selectedProject={chooserProjects[0]}
        projects={[...chooserProjects]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Claude" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Opus 4.8" })[0]!);
    fireEvent.change(screen.getByPlaceholderText("newSessionPlaceholder"), {
      target: { value: "hello" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "newSessionStartAction" }),
    );

    await waitFor(() => {
      expect(mockStartSession).toHaveBeenCalledTimes(1);
    });

    expect(mockStartSession).toHaveBeenCalledWith(
      "project-1",
      "hello",
      expect.objectContaining({
        provider: "claude",
        model: "opus",
        recapAfterSeconds: 300,
        promptSuggestionMode: "off",
      }),
      undefined,
      expect.any(Number),
    );
    expect(mockNavigate).toHaveBeenCalledWith(
      "/projects/project-1/sessions/session-1",
      expect.objectContaining({
        state: expect.objectContaining({
          initialStatus: expect.objectContaining({
            owner: "self",
            processId: "process-1",
            permissionMode: "default",
            modeVersion: 0,
            recapAfterSeconds: 300,
          }),
          initialProvider: "claude",
        }),
      }),
    );
  });

  it("shows and submits the saved sandbox only with server capability", async () => {
    versionState.version = {
      capabilities: [
        PROJECT_QUEUE_CAPABILITY,
        SESSION_SANDBOXING_CAPABILITY,
        SESSION_SANDBOXING_STATUS_CAPABILITY,
      ],
      sessionSandboxing: {
        state: "available",
        platform: "linux",
        backend: "bubblewrap",
        version: "0.4.0",
      },
    };
    serverSettingsState.settings = {
      newSessionDefaults: {
        provider: "claude",
        model: "opus",
        permissionMode: "default",
        sandboxLevel: "project-write",
      },
    };
    serverSettingsState.isLoading = false;

    render(
      <NewSessionForm
        projectId="project-1"
        selectedProject={chooserProjects[0]}
        projects={[...chooserProjects]}
      />,
    );

    expect(
      (
        screen.getByRole("checkbox", {
          name: "newSessionSandboxLabel",
        }) as HTMLInputElement
      ).checked,
    ).toBe(true);
    fireEvent.change(screen.getByPlaceholderText("newSessionPlaceholder"), {
      target: { value: "sandbox this" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "newSessionStartAction" }),
    );

    await waitFor(() => {
      expect(mockStartSession).toHaveBeenCalledTimes(1);
    });
    expect(mockStartSession.mock.calls[0]?.[2]).toEqual(
      expect.objectContaining({ sandboxLevel: "project-write" }),
    );
  });

  it("turns off side-session recaps when sandboxing is enabled", async () => {
    versionState.version = {
      capabilities: [
        PROJECT_QUEUE_CAPABILITY,
        SESSION_SANDBOXING_CAPABILITY,
        SESSION_SANDBOXING_STATUS_CAPABILITY,
      ],
      sessionSandboxing: {
        state: "available",
        platform: "linux",
        backend: "bubblewrap",
        version: "0.4.0",
      },
    };
    serverSettingsState.settings = {
      newSessionDefaults: {
        provider: "claude",
        permissionMode: "default",
        recapMode: "side-session",
      },
    };
    serverSettingsState.isLoading = false;

    render(
      <NewSessionForm
        projectId="project-1"
        selectedProject={chooserProjects[0]}
        projects={[...chooserProjects]}
      />,
    );

    const sandbox = screen.getByRole("checkbox", {
      name: "newSessionSandboxLabel",
    });
    const sideSession = screen.getByRole("button", {
      name: "recapModeSideSession",
    }) as HTMLButtonElement;
    expect(sideSession.disabled).toBe(false);

    fireEvent.click(sandbox);

    expect(sideSession.disabled).toBe(true);
    expect(
      (
        screen.getByRole("button", {
          name: "recapModeFork",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
    expect(
      screen.getByRole("button", { name: "recapModeOff" }).className,
    ).toContain("selected");

    fireEvent.change(screen.getByPlaceholderText("newSessionPlaceholder"), {
      target: { value: "sandbox without side helper" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "newSessionStartAction" }),
    );

    await waitFor(() => {
      expect(mockStartSession).toHaveBeenCalledTimes(1);
    });
    expect(mockStartSession.mock.calls[0]?.[2]).toEqual(
      expect.objectContaining({
        sandboxLevel: "project-write",
        recapMode: "off",
      }),
    );
  });

  it("hides and omits sandbox state from an older server", async () => {
    versionState.version = { capabilities: [PROJECT_QUEUE_CAPABILITY] };
    serverSettingsState.settings = {
      newSessionDefaults: {
        provider: "claude",
        model: "opus",
        permissionMode: "default",
        sandboxLevel: "project-write",
      },
    };
    serverSettingsState.isLoading = false;

    render(
      <NewSessionForm
        projectId="project-1"
        selectedProject={chooserProjects[0]}
        projects={[...chooserProjects]}
      />,
    );

    expect(
      screen.queryByRole("checkbox", { name: "newSessionSandboxLabel" }),
    ).toBeNull();
    fireEvent.change(screen.getByPlaceholderText("newSessionPlaceholder"), {
      target: { value: "ordinary session" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "newSessionStartAction" }),
    );

    await waitFor(() => {
      expect(mockStartSession).toHaveBeenCalledTimes(1);
    });
    expect(mockStartSession.mock.calls[0]?.[2]).not.toHaveProperty(
      "sandboxLevel",
    );
  });

  it("hides sandboxing from an intermediate protocol-only server", () => {
    versionState.version = {
      capabilities: [PROJECT_QUEUE_CAPABILITY, SESSION_SANDBOXING_CAPABILITY],
    };
    serverSettingsState.settings = {
      newSessionDefaults: {
        provider: "claude",
        sandboxLevel: "project-write",
      },
    };
    serverSettingsState.isLoading = false;

    render(
      <NewSessionForm
        projectId="project-1"
        selectedProject={chooserProjects[0]}
        projects={[...chooserProjects]}
      />,
    );

    expect(
      screen.queryByRole("checkbox", { name: "newSessionSandboxLabel" }),
    ).toBeNull();
  });

  it("hides sandboxing when the server reports an unsupported host", () => {
    versionState.version = {
      capabilities: [SESSION_SANDBOXING_STATUS_CAPABILITY],
      sessionSandboxing: {
        state: "unsupported-platform",
        platform: "darwin",
      },
    };
    serverSettingsState.settings = {
      newSessionDefaults: {
        provider: "claude",
        sandboxLevel: "project-write",
      },
    };
    serverSettingsState.isLoading = false;

    render(
      <NewSessionForm
        projectId="project-1"
        selectedProject={chooserProjects[0]}
        projects={[...chooserProjects]}
      />,
    );

    expect(
      screen.queryByRole("checkbox", { name: "newSessionSandboxLabel" }),
    ).toBeNull();
  });

  it("hides and disables sandboxing for an unimplemented provider", async () => {
    versionState.version = {
      capabilities: [
        PROJECT_QUEUE_CAPABILITY,
        SESSION_SANDBOXING_CAPABILITY,
        SESSION_SANDBOXING_STATUS_CAPABILITY,
      ],
      sessionSandboxing: {
        state: "available",
        platform: "linux",
        backend: "bubblewrap",
        version: "0.4.0",
      },
    };
    providersState.providers = [
      {
        name: "opencode",
        displayName: "OpenCode",
        installed: true,
        authenticated: true,
        supportsPermissionMode: true,
        supportsThinkingToggle: true,
        models: [{ id: "default", name: "Default" }],
      },
    ];
    serverSettingsState.settings = {
      newSessionDefaults: {
        provider: "opencode",
        model: "default",
        permissionMode: "default",
        sandboxLevel: "project-write",
      },
    };
    serverSettingsState.isLoading = false;

    render(
      <NewSessionForm
        projectId="project-1"
        selectedProject={chooserProjects[0]}
        projects={[...chooserProjects]}
      />,
    );

    expect(
      screen.queryByRole("checkbox", { name: "newSessionSandboxLabel" }),
    ).toBeNull();
    fireEvent.change(screen.getByPlaceholderText("newSessionPlaceholder"), {
      target: { value: "ordinary OpenCode session" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "newSessionStartAction" }),
    );

    await waitFor(() => {
      expect(mockStartSession).toHaveBeenCalledTimes(1);
    });
    expect(mockStartSession.mock.calls[0]?.[2]).toEqual(
      expect.objectContaining({ sandboxLevel: "none" }),
    );
  });

  it("submits the selected workstream when starting a project session", async () => {
    serverSettingsState.settings = {
      workstreamsEnabled: true,
    };
    serverSettingsState.isLoading = false;
    mockGetProjectWorkstreams.mockResolvedValue({
      projectId: "project-1",
      workstreams: [
        {
          id: "main:project-1",
          projectId: "project-1",
          label: "Main",
          kind: "main",
          path: "/tmp/alpha",
          branch: "main",
          baseBranch: "main",
          baseCommit: null,
          managedByYa: false,
          queuePaused: false,
          status: "active",
          createdAt: "1970-01-01T00:00:00.000Z",
          updatedAt: "1970-01-01T00:00:00.000Z",
        },
        {
          id: "ws-lane",
          projectId: "project-1",
          label: "tools cleanup",
          kind: "checkout",
          path: "/tmp/checkouts/alpha/tools-cleanup",
          branch: "main",
          baseBranch: "main",
          baseCommit: null,
          managedByYa: true,
          queuePaused: false,
          status: "active",
          createdAt: "2026-07-05T10:00:00.000Z",
          updatedAt: "2026-07-05T10:00:00.000Z",
        },
      ],
    });

    render(
      <NewSessionForm
        projectId="project-1"
        selectedProject={chooserProjects[0]}
        projects={[...chooserProjects]}
      />,
    );

    const workstreamSelect = (await screen.findByLabelText(
      "newSessionWorkstreamLabel",
    )) as HTMLSelectElement;
    fireEvent.change(workstreamSelect, { target: { value: "ws-lane" } });
    fireEvent.change(screen.getByPlaceholderText("newSessionPlaceholder"), {
      target: { value: "hello" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "newSessionStartAction" }),
    );

    await waitFor(() => {
      expect(mockStartSession).toHaveBeenCalledWith(
        "project-1",
        "hello",
        expect.objectContaining({
          workstreamId: "ws-lane",
        }),
        undefined,
        expect.any(Number),
      );
    });
  });

  it("stages selected new-session files into the draft envelope", async () => {
    serverSettingsState.isLoading = false;
    mockUploadStagedAttachment.mockResolvedValue(stagedRef);
    const { container } = render(
      <NewSessionForm
        projectId="project-1"
        selectedProject={chooserProjects[0]}
        projects={[...chooserProjects]}
      />,
    );

    const input =
      container.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error("missing file input");
    const file = new File(["hello"], "notes.txt", { type: "text/plain" });

    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      expect(mockUploadStagedAttachment).toHaveBeenCalledTimes(1);
      expect(draftAttachmentState.value?.refs).toEqual([stagedRef]);
    });
    expect(screen.getByText("notes.txt")).toBeTruthy();
  });

  it("shows duplicate new-session attachment names with numeric suffixes", async () => {
    serverSettingsState.isLoading = false;
    mockUploadStagedAttachment.mockImplementation(async (file: File) => ({
      ...stagedRef,
      id: `staged-${file.name}`,
      originalName: `server-${file.name}`,
      name: `staged-${file.name}`,
    }));
    const { container } = render(
      <NewSessionForm
        projectId="project-1"
        selectedProject={chooserProjects[0]}
        projects={[...chooserProjects]}
      />,
    );

    const input =
      container.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error("missing file input");

    fireEvent.change(input, {
      target: {
        files: [
          new File(["a"], "image.png", { type: "image/png" }),
          new File(["b"], "image.png", { type: "image/png" }),
        ],
      },
    });

    await waitFor(() => {
      expect(mockUploadStagedAttachment).toHaveBeenCalledTimes(2);
    });

    expect(
      mockUploadStagedAttachment.mock.calls.map(([file]) => file.name),
    ).toEqual(["image.png", "image-1.png"]);
    expect(screen.getByText("image.png")).toBeTruthy();
    expect(screen.getByText("image-1.png")).toBeTruthy();
    expect(
      draftAttachmentState.value?.refs.map((ref) => ref.originalName),
    ).toEqual(["image.png", "image-1.png"]);
  });

  it("materializes staged new-session files after creating the session", async () => {
    serverSettingsState.isLoading = false;
    mockUploadStagedAttachment.mockResolvedValue(stagedRef);
    mockConnectionFetch.mockResolvedValue({ files: [materializedFile] });
    const { container } = render(
      <NewSessionForm
        projectId="project-1"
        selectedProject={chooserProjects[0]}
        projects={[...chooserProjects]}
      />,
    );

    const input =
      container.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error("missing file input");
    const file = new File(["hello"], "notes.txt", { type: "text/plain" });

    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => {
      expect(draftAttachmentState.value?.refs).toEqual([stagedRef]);
    });

    fireEvent.change(screen.getByPlaceholderText("newSessionPlaceholder"), {
      target: { value: "start with file" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "newSessionStartAction" }),
    );

    await waitFor(() => {
      expect(mockQueueMessage).toHaveBeenCalledTimes(1);
    });

    expect(mockCreateSession).toHaveBeenCalledWith(
      "project-1",
      expect.objectContaining({
        provider: "claude",
        model: "opus",
      }),
    );
    expect(mockConnectionFetch).toHaveBeenCalledWith(
      "/projects/project-1/sessions/session-created/attachments/staging/materialize",
      {
        method: "POST",
        body: JSON.stringify({
          batchId: "batch-new-session",
          refs: [stagedRef],
        }),
      },
    );
    expect(mockQueueMessage).toHaveBeenCalledWith(
      "session-created",
      "start with file",
      "default",
      [materializedFile],
      undefined,
      "off",
      undefined,
      expect.any(Number),
      undefined,
      undefined,
      "default",
    );
    expect(draftAttachmentState.value).toBe(null);
  });

  it("queues a new session through Project Queue when the toolbar action is visible", async () => {
    toolbarVisibilityState.projectQueue = true;
    inboxState.active = [
      { sessionId: "session-active", projectId: "project-1" },
    ];
    serverSettingsState.isLoading = false;

    render(
      <NewSessionForm
        projectId="project-1"
        selectedProject={chooserProjects[0]}
        projects={[...chooserProjects]}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText("newSessionPlaceholder"), {
      target: { value: "queued project work" },
    });
    const projectQueueButton = screen.getByRole("button", {
      name: "toolbarProjectQueueLabel",
    });
    expect(projectQueueButton.getAttribute("title")).toBe(
      "Send after all sessions in this project are idle\nCtrl+Enter",
    );
    fireEvent.click(projectQueueButton);

    await waitFor(() => {
      expect(mockCreateProjectQueueItem).toHaveBeenCalledTimes(1);
    });

    expect(mockCreateProjectQueueItem).toHaveBeenCalledWith(
      "project-1",
      expect.objectContaining({
        target: expect.objectContaining({
          type: "new-session",
          mode: "default",
          model: "opus",
          provider: "claude",
        }),
        message: expect.objectContaining({
          text: "queued project work",
          mode: "default",
          metadata: expect.objectContaining({
            deliveryIntent: "deferred",
            clientTimestamp: expect.any(Number),
          }),
        }),
        createdFrom: { client: "new-session" },
      }),
    );
    expect(mockStartSession).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(mockReportProjectQueueCollectionSnapshot).toHaveBeenCalledWith({
      projectId: "project-1",
      items: [],
    });
  });

  it("uses Ctrl+Enter to queue a new session through Project Queue", async () => {
    toolbarVisibilityState.projectQueue = true;
    inboxState.active = [
      { sessionId: "session-active", projectId: "project-1" },
    ];
    serverSettingsState.isLoading = false;

    render(
      <NewSessionForm
        projectId="project-1"
        selectedProject={chooserProjects[0]}
        projects={[...chooserProjects]}
      />,
    );

    const composer = screen.getByPlaceholderText("newSessionPlaceholder");
    fireEvent.change(composer, {
      target: { value: "queued project shortcut" },
    });
    fireEvent.keyDown(composer, { key: "Enter", ctrlKey: true });

    await waitFor(() => {
      expect(mockCreateProjectQueueItem).toHaveBeenCalledTimes(1);
    });

    expect(mockCreateProjectQueueItem).toHaveBeenCalledWith(
      "project-1",
      expect.objectContaining({
        message: expect.objectContaining({
          text: "queued project shortcut",
          metadata: expect.objectContaining({
            deliveryIntent: "deferred",
          }),
        }),
        createdFrom: { client: "new-session" },
      }),
    );
    expect(mockStartSession).not.toHaveBeenCalled();
  });

  it("queues staged new-session files through Project Queue", async () => {
    toolbarVisibilityState.projectQueue = true;
    inboxState.active = [
      { sessionId: "session-active", projectId: "project-1" },
    ];
    serverSettingsState.isLoading = false;
    mockUploadStagedAttachment.mockResolvedValue(stagedRef);
    const { container } = render(
      <NewSessionForm
        projectId="project-1"
        selectedProject={chooserProjects[0]}
        projects={[...chooserProjects]}
      />,
    );

    const input =
      container.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error("missing file input");
    fireEvent.change(input, {
      target: {
        files: [new File(["hello"], "notes.txt", { type: "text/plain" })],
      },
    });
    await waitFor(() => {
      expect(draftAttachmentState.value?.refs).toEqual([stagedRef]);
    });

    fireEvent.change(screen.getByPlaceholderText("newSessionPlaceholder"), {
      target: { value: "queued project work with file" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "toolbarProjectQueueLabel" }),
    );

    await waitFor(() => {
      expect(mockCreateProjectQueueItem).toHaveBeenCalledTimes(1);
    });

    expect(mockCreateProjectQueueItem).toHaveBeenCalledWith(
      "project-1",
      expect.objectContaining({
        message: expect.objectContaining({
          text: "queued project work with file",
          stagedAttachments: {
            batchId: stagedRef.batchId,
            refs: [stagedRef],
            updatedAt: expect.any(String),
          },
        }),
      }),
    );
    expect(mockCreateSession).not.toHaveBeenCalled();
    expect(mockQueueMessage).not.toHaveBeenCalled();
    expect(draftAttachmentState.value).toBe(null);
  });

  it("shows the new-session Project Queue action from project blocking counts", () => {
    toolbarVisibilityState.projectQueue = true;
    serverSettingsState.isLoading = false;
    const activeProject = {
      ...chooserProjects[0],
      projectQueueBlockingCount: 1,
    };

    render(
      <NewSessionForm
        projectId="project-1"
        selectedProject={activeProject}
        projects={[activeProject, chooserProjects[1]]}
      />,
    );

    expect(
      screen.getByRole("button", { name: "toolbarProjectQueueLabel" }),
    ).toBeTruthy();
  });

  it("hides the new-session Project Queue action when the project is inactive", () => {
    toolbarVisibilityState.projectQueue = true;
    serverSettingsState.isLoading = false;

    render(
      <NewSessionForm
        projectId="project-1"
        selectedProject={chooserProjects[0]}
        projects={[...chooserProjects]}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "toolbarProjectQueueLabel" }),
    ).toBe(null);
  });

  it("hides the new-session Project Queue action without server capability", () => {
    toolbarVisibilityState.projectQueue = true;
    versionState.version = { capabilities: [] };
    inboxState.active = [
      { sessionId: "session-active", projectId: "project-1" },
    ];
    serverSettingsState.isLoading = false;

    render(
      <NewSessionForm
        projectId="project-1"
        selectedProject={chooserProjects[0]}
        projects={[...chooserProjects]}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "toolbarProjectQueueLabel" }),
    ).toBe(null);
  });

  it("hides the new-session Project Queue action by default", () => {
    render(
      <NewSessionForm
        projectId="project-1"
        selectedProject={chooserProjects[0]}
        projects={[...chooserProjects]}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "toolbarProjectQueueLabel" }),
    ).toBe(null);
  });

  it("shows and updates the initial provider effort selector", async () => {
    modelSettingsState.thinkingMode = "on";
    modelSettingsState.effortLevel = "medium";
    serverSettingsState.isLoading = false;

    render(
      <NewSessionForm
        projectId="project-1"
        selectedProject={chooserProjects[0]}
        projects={[...chooserProjects]}
      />,
    );

    const medium = screen.getByRole("radio", { name: "Medium" });
    expect(medium.className).toContain("active");

    fireEvent.click(screen.getByRole("radio", { name: "Low" }));

    await waitFor(() => {
      expect(mockUpdateSetting).toHaveBeenCalledWith(
        "newSessionDefaults",
        expect.objectContaining({
          provider: "claude",
          providers: expect.objectContaining({
            claude: expect.objectContaining({
              model: "opus",
              thinkingMode: "on",
              effortLevel: "low",
            }),
          }),
        }),
      );
    });
  });

  it("shows the Show-thinking control in session setup", () => {
    modelSettingsState.thinkingMode = "on";

    render(
      <NewSessionForm
        projectId="project-1"
        selectedProject={chooserProjects[0]}
        projects={[...chooserProjects]}
      />,
    );

    // Provider thinking and Show-thinking are separate sections, but both are
    // still available during session setup.
    expect(
      screen.getAllByText("modelSettingsThinkingTitle").length,
    ).toBeGreaterThan(0);
    expect(screen.getByText("showThinkingTitle")).toBeDefined();
  });

  it("shows detached and recent project choices in the default launcher", () => {
    render(<NewSessionForm projects={[...chooserProjects]} />);

    expect(
      screen.getByPlaceholderText("newSessionProjectPathPlaceholder"),
    ).toBeDefined();

    fireEvent.click(
      screen.getByRole("button", { name: /newSessionProjectDetached/i }),
    );

    expect(screen.getAllByText("newSessionProjectDetached")).toHaveLength(2);
    expect(screen.getAllByText("Alpha").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Beta").length).toBeGreaterThan(0);
  });

  it("shows recent projects when opening a selected project chooser", () => {
    const { container } = render(
      <NewSessionForm
        projectId="project-1"
        selectedProject={chooserProjects[0]}
        projects={[...chooserProjects]}
      />,
    );

    const projectInput = screen.getByPlaceholderText(
      "newSessionProjectPathPlaceholder",
    ) as HTMLInputElement;
    expect(projectInput.value).toBe("/tmp/alpha");

    fireEvent.click(
      container.querySelector(".new-session-project-summary") as HTMLElement,
    );

    const shortcutNames = () =>
      Array.from(
        container.querySelectorAll(
          ".new-session-project-suggestions .new-session-project-option-name",
        ),
        (element) => element.textContent,
      );

    expect(shortcutNames()).toEqual([
      "newSessionProjectDetached",
      "Alpha",
      "Beta",
    ]);

    const projectOptions = container.querySelectorAll(
      ".new-session-project-suggestions .new-session-project-option",
    );
    expect(projectOptions[0]?.className).not.toContain("selected");
    expect(projectOptions[1]?.className).toContain("selected");

    fireEvent.change(projectInput, { target: { value: "Beta" } });

    expect(shortcutNames()).toEqual(["newSessionProjectDetached", "Beta"]);
  });

  it("closes the project chooser when interacting outside it", () => {
    const { container } = render(
      <NewSessionForm
        projectId="project-1"
        selectedProject={chooserProjects[0]}
        projects={[...chooserProjects]}
      />,
    );

    fireEvent.click(
      container.querySelector(".new-session-project-summary") as HTMLElement,
    );

    expect(
      container.querySelector("#new-session-project-panel"),
    ).not.toBeNull();

    fireEvent.pointerDown(screen.getByPlaceholderText("newSessionPlaceholder"));

    expect(container.querySelector("#new-session-project-panel")).toBeNull();
  });

  it("keeps the project chooser open while typing a custom path", () => {
    const { container } = render(
      <NewSessionForm
        projectId="project-1"
        selectedProject={chooserProjects[0]}
        projects={[...chooserProjects]}
      />,
    );

    const projectInput = screen.getByPlaceholderText(
      "newSessionProjectPathPlaceholder",
    ) as HTMLInputElement;

    fireEvent.click(
      container.querySelector(".new-session-project-summary") as HTMLElement,
    );
    fireEvent.pointerDown(projectInput);
    fireEvent.focus(projectInput);
    fireEvent.change(projectInput, {
      target: { value: "/Users/kgraehl/code/yepanywhere" },
    });

    expect(
      container.querySelector("#new-session-project-panel"),
    ).not.toBeNull();
    expect(screen.getByText("newSessionProjectUseTypedPath")).toBeDefined();
    expect(screen.getByText("/Users/kgraehl/code/yepanywhere")).toBeDefined();
  });

  it("uses visit recency and shows more than four project shortcuts", () => {
    const manyProjects = [
      ...chooserProjects,
      {
        id: "project-3",
        name: "Gamma",
        path: "/tmp/gamma",
        sessionCount: 1,
        activeOwnedCount: 0,
        activeExternalCount: 0,
        lastActivity: "2026-04-21T10:00:00.000Z",
      },
      {
        id: "project-4",
        name: "Delta",
        path: "/tmp/delta",
        sessionCount: 1,
        activeOwnedCount: 0,
        activeExternalCount: 0,
        lastActivity: "2026-04-20T10:00:00.000Z",
      },
      {
        id: "project-5",
        name: "Epsilon",
        path: "/tmp/epsilon",
        sessionCount: 1,
        activeOwnedCount: 0,
        activeExternalCount: 0,
        lastActivity: "2026-04-19T10:00:00.000Z",
      },
      {
        id: "project-6",
        name: "Zeta",
        path: "/tmp/zeta",
        sessionCount: 1,
        activeOwnedCount: 0,
        activeExternalCount: 0,
        lastActivity: "2026-04-18T10:00:00.000Z",
      },
    ];

    const { container } = render(
      <NewSessionForm
        projects={manyProjects}
        recentProjectIds={["project-6", "project-5"]}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: /newSessionProjectDetached/i }),
    );

    const shortcutNames = Array.from(
      container.querySelectorAll(
        ".new-session-project-suggestions .new-session-project-option-name",
      ),
      (element) => element.textContent,
    );

    expect(shortcutNames).toEqual([
      "newSessionProjectDetached",
      "Zeta",
      "Epsilon",
      "Alpha",
      "Beta",
      "Gamma",
      "Delta",
    ]);
  });

  it("keeps attachment quality out of the bottom composer row", () => {
    render(<NewSessionForm projects={[...chooserProjects]} />);

    expect(screen.queryByRole("button", { name: "SD" })).toBeNull();
    expect(screen.queryByRole("button", { name: "HD" })).toBeNull();
  });

  it("places all-provider controls before provider-specific controls", async () => {
    serverSettingsState.isLoading = false;

    const { container } = render(
      <NewSessionForm
        projectId="project-1"
        selectedProject={chooserProjects[0]}
        projects={[...chooserProjects]}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("newSessionRecapTitle")).toBeDefined();
      expect(
        screen.getByText("newSessionPromptSuggestionsTitle"),
      ).toBeDefined();
    });

    const headings = Array.from(
      container.querySelectorAll(".new-session-provider-slot h3"),
      (element) => element.textContent,
    );
    expect(headings.indexOf("newSessionModeTitle")).toBeGreaterThan(
      headings.indexOf("newSessionPromptSuggestionsTitle"),
    );
    expect(headings.indexOf("showThinkingTitle")).toBeGreaterThan(
      headings.indexOf("newSessionModeTitle"),
    );
    expect(headings.indexOf("newSessionProviderTitle")).toBeGreaterThan(
      headings.indexOf("showThinkingTitle"),
    );
    expect(headings.indexOf("modelSettingsThinkingTitle")).toBeGreaterThan(
      headings.indexOf("newSessionModelTitle"),
    );
  });

  it("uses the selected rapid-speech prefix for new-session Project Queue", async () => {
    toolbarVisibilityState.projectQueue = true;
    inboxState.active = [
      { sessionId: "session-active", projectId: "project-1" },
    ];
    serverSettingsState.isLoading = false;
    window.localStorage.setItem(UI_KEYS.speechAsrAttributionMs, "1000");
    window.localStorage.setItem(UI_KEYS.speechMessagePrefixMode, "stt");

    render(
      <NewSessionForm
        projectId="project-1"
        selectedProject={chooserProjects[0]}
        projects={[...chooserProjects]}
      />,
    );

    act(() => {
      voicePropsState.current?.onListeningStart?.();
      voicePropsState.current?.onTranscript?.("queued speech");
    });

    const projectQueueButton = screen.getByRole("button", {
      name: /toolbarProjectQueueLabel.*\[STT\]/,
    });
    expect(projectQueueButton.textContent).toContain("STT");
    expect(
      screen.getByRole("button", { name: /newSessionStartAction.*\[STT\]/ }),
    ).toBeDefined();
    fireEvent.click(projectQueueButton);

    await waitFor(() => {
      expect(mockCreateProjectQueueItem).toHaveBeenCalledWith(
        "project-1",
        expect.objectContaining({
          message: expect.objectContaining({ text: "[STT] queued speech" }),
        }),
      );
    });
  });

  it("shows the selected recap timing description as a caption and tooltip", async () => {
    serverSettingsState.settings = {
      newSessionDefaults: {
        provider: "claude",
        permissionMode: "default",
        recapMode: "side-session",
        recapAfterSeconds: 124,
      },
    };
    serverSettingsState.isLoading = false;

    render(
      <NewSessionForm
        projectId="project-1"
        selectedProject={chooserProjects[0]}
        projects={[...chooserProjects]}
      />,
    );

    const tailedDescription =
      "Summarize tailed assistant output after backgrounding (not closing) for 124 s.";
    const forkedDescription =
      "Summarize from a temporary fork after backgrounding (not closing) for 124 s.";

    await waitFor(() => {
      expect(screen.getByText(tailedDescription)).toBeDefined();
    });
    expect(
      screen
        .getByRole("button", { name: "recapModeSideSession" })
        .getAttribute("title"),
    ).toBe(tailedDescription);
    expect(
      screen
        .getByRole("button", { name: "recapModeFork" })
        .getAttribute("title"),
    ).toBe(forkedDescription);
  });

  it("keeps the drafted prompt when switching from detached to a project", async () => {
    const onProjectChange = vi.fn();

    render(
      <NewSessionForm
        projects={[...chooserProjects]}
        onProjectChange={onProjectChange}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText("newSessionPlaceholder"), {
      target: { value: "draft the migration plan" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: /newSessionProjectDetached/i }),
    );
    fireEvent.click(screen.getAllByRole("button", { name: /Alpha/i })[0]!);

    expect(onProjectChange).toHaveBeenCalledWith("project-1");
    expect(
      (
        screen.getByPlaceholderText(
          "newSessionPlaceholder",
        ) as HTMLTextAreaElement
      ).value,
    ).toBe("draft the migration plan");
  });

  it("keeps the same draft storage key when project selection changes", () => {
    const { rerender } = render(
      <NewSessionForm projects={[...chooserProjects]} />,
    );

    rerender(
      <NewSessionForm
        projectId="project-1"
        selectedProject={chooserProjects[0]}
        projects={[...chooserProjects]}
      />,
    );

    expect(new Set(draftKeys)).toEqual(
      new Set(["draft-new-session:host%3Atest"]),
    );
  });

  it("resolves a typed project path before starting the session", async () => {
    render(<NewSessionForm projects={[...chooserProjects]} />);

    fireEvent.change(
      screen.getByPlaceholderText("newSessionProjectPathPlaceholder"),
      {
        target: { value: "/tmp/added-project" },
      },
    );
    fireEvent.change(screen.getByPlaceholderText("newSessionPlaceholder"), {
      target: { value: "hello" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "newSessionStartAction" }),
    );

    await waitFor(() => {
      expect(mockAddProject).toHaveBeenCalledWith("/tmp/added-project");
      expect(mockStartSession).toHaveBeenCalledWith(
        "project-added",
        "hello",
        expect.any(Object),
        undefined,
        expect.any(Number),
      );
    });
  });

  it("starts a detached session when no project is selected", async () => {
    render(<NewSessionForm projects={[...chooserProjects]} />);

    fireEvent.change(screen.getByPlaceholderText("newSessionPlaceholder"), {
      target: { value: "hello" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "newSessionStartAction" }),
    );

    await waitFor(() => {
      expect(mockStartDetachedSession).toHaveBeenCalledWith(
        "hello",
        expect.any(Object),
        undefined,
        expect.any(Number),
      );
    });

    expect(mockStartSession).not.toHaveBeenCalled();
    expect(mockNavigate).toHaveBeenCalledWith(
      "/projects/detached-project/sessions/session-detached",
      expect.any(Object),
    );
  });

  it("toggles new-session voice input on Ctrl+Space", () => {
    render(
      <NewSessionForm
        projectId="project-1"
        selectedProject={chooserProjects[0]}
        projects={[...chooserProjects]}
      />,
    );

    fireEvent.keyDown(screen.getByPlaceholderText("newSessionPlaceholder"), {
      key: " ",
      code: "Space",
      ctrlKey: true,
    });

    expect(mockVoiceToggle).toHaveBeenCalledTimes(1);
  });

  it("keeps mic focus through coarse-pointer speech transitions", () => {
    coarsePointerState.current = true;
    render(
      <NewSessionForm
        projectId="project-1"
        selectedProject={chooserProjects[0]}
        projects={[...chooserProjects]}
      />,
    );
    const textarea = screen.getByPlaceholderText("newSessionPlaceholder");
    const voice = screen.getByRole("button", { name: "voice" });

    act(() => voice.focus());
    act(() => voicePropsState.current?.onListeningStart?.());
    expect(document.activeElement).toBe(voice);

    act(() => voicePropsState.current?.onListeningStop?.());
    expect(document.activeElement).toBe(voice);
    expect(document.activeElement).not.toBe(textarea);
  });

  it("returns keyboard mic focus to the fine-pointer composer", () => {
    render(
      <NewSessionForm
        projectId="project-1"
        selectedProject={chooserProjects[0]}
        projects={[...chooserProjects]}
      />,
    );
    const textarea = screen.getByPlaceholderText("newSessionPlaceholder");
    const voice = screen.getByRole("button", { name: "voice" });

    act(() => voice.focus());
    act(() => voicePropsState.current?.onListeningStart?.());
    expect(document.activeElement).toBe(textarea);

    act(() => voice.focus());
    act(() => voicePropsState.current?.onListeningStop?.());
    expect(document.activeElement).toBe(textarea);
  });

  it("prefixes speech-triggered new-session submissions with ASR", async () => {
    render(
      <NewSessionForm
        projectId="project-1"
        selectedProject={chooserProjects[0]}
        projects={[...chooserProjects]}
      />,
    );
    const textarea = screen.getByPlaceholderText(
      "newSessionPlaceholder",
    ) as HTMLTextAreaElement;

    act(() => {
      voicePropsState.current?.onTranscript?.("Start here.");
    });
    await waitFor(() => expect(textarea.value).toBe("Start here."));

    act(() => {
      voicePropsState.current?.onTranscript?.("", {
        smartTurnCommand: "send",
        smartTurnAutoSend: true,
      });
    });

    await waitFor(() => {
      expect(mockStartSession).toHaveBeenCalledWith(
        "project-1",
        "[ASR] Start here.",
        expect.any(Object),
        undefined,
        expect.any(Number),
      );
    });
    expect(mockVoiceContinueAfterSpeechSend).toHaveBeenCalledOnce();
  });

  it("starts with the visible interim snapshot after speech settles", async () => {
    window.localStorage.setItem(UI_KEYS.speechAsrAttributionMs, "500");
    render(
      <NewSessionForm
        projectId="project-1"
        selectedProject={chooserProjects[0]}
        projects={[...chooserProjects]}
      />,
    );

    act(() => {
      voicePropsState.current?.onPendingSpeechChange?.("listening");
      voicePropsState.current?.onInterimTranscript?.("provisional words");
    });
    const start = screen.getByRole("button", {
      name: /newSessionStartAction/,
    });
    expect(start.textContent).toContain("ASR");
    fireEvent.click(start);
    expect(mockStartSession).not.toHaveBeenCalled();

    act(() => {
      voicePropsState.current?.onPendingSpeechChange?.("finalizing");
      voicePropsState.current?.onTranscript?.("backend final words");
    });
    await waitFor(() => {
      expect(
        (
          screen.getByPlaceholderText(
            "newSessionPlaceholder",
          ) as HTMLTextAreaElement
        ).value,
      ).toBe("backend final words");
    });
    act(() => {
      voicePropsState.current?.onPendingSpeechChange?.(null, "completed");
    });

    await waitFor(() => {
      expect(mockStartSession).toHaveBeenCalledWith(
        "project-1",
        "[ASR] provisional words",
        expect.any(Object),
        undefined,
        expect.any(Number),
      );
    });
    expect(mockStartSession.mock.calls[0]?.[1]).not.toContain(
      "backend final words",
    );
  });

  it("keeps the real new-session textarea editable while transcribing", async () => {
    render(
      <NewSessionForm
        projectId="project-1"
        selectedProject={chooserProjects[0]}
        projects={[...chooserProjects]}
      />,
    );
    const textarea = screen.getByPlaceholderText(
      "newSessionPlaceholder",
    ) as HTMLTextAreaElement;

    act(() => {
      screen.getByRole("button", { name: "voice" }).focus();
      voicePropsState.current?.onListeningStop?.();
      voicePropsState.current?.onPendingSpeechChange?.("transcribing");
    });
    await waitFor(() => {
      expect(document.querySelector(".speech-draft-mirror")).toBeNull();
    });
    expect(
      document.querySelector(".speech-draft-field")?.classList,
    ).not.toContain("has-interim");
    expect(document.activeElement).toBe(textarea);

    expect(textarea.disabled).toBe(false);
    fireEvent.change(textarea, {
      target: { value: "typed while transcribing" },
    });
    expect(textarea.value).toBe("typed while transcribing");

    fireEvent.keyDown(textarea, { key: "Escape" });
    expect(mockVoiceCancelProcessing).toHaveBeenCalledTimes(1);
    expect(textarea.value).toBe("typed while transcribing");
  });

  it("commits the visible interim when the new-session mic stops", async () => {
    render(
      <NewSessionForm
        projectId="project-1"
        selectedProject={chooserProjects[0]}
        projects={[...chooserProjects]}
      />,
    );
    const textarea = screen.getByPlaceholderText(
      "newSessionPlaceholder",
    ) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "alpha omega" } });
    textarea.setSelectionRange("alpha".length, "alpha".length);

    act(() => {
      voicePropsState.current?.onListeningStart?.();
      voicePropsState.current?.onInterimTranscript?.("visible words");
    });
    let committed = false;
    act(() => {
      committed = voicePropsState.current?.onListeningStop?.() === true;
    });

    await waitFor(() => {
      expect(textarea.value).toBe("alpha visible words omega");
    });
    expect(committed).toBe(true);
  });

  it("keeps Listening out of the draft and places the caret after provisional speech", async () => {
    render(
      <NewSessionForm
        projectId="project-1"
        selectedProject={chooserProjects[0]}
        projects={[...chooserProjects]}
      />,
    );

    act(() => {
      voicePropsState.current?.onPendingSpeechChange?.("listening");
    });
    await waitFor(() =>
      expect(document.querySelector(".speech-draft-mirror")).toBeNull(),
    );

    act(() => {
      voicePropsState.current?.onInterimTranscript?.("live words");
    });
    const interim = await waitFor(() => {
      const el = document.querySelector(".speech-interim-inline");
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(interim.nextElementSibling?.classList).toContain(
      "speech-interim-caret",
    );
  });

  it("hides a stored YA-routed Grok batch method from the method list", () => {
    versionState.version = {
      voiceBackends: ["ya-grok"],
      voiceBackendCapabilities: {
        "ya-grok": { streaming: true, smartTurn: true },
      },
    };
    modelSettingsState.speechMethod = "browser-native";
    modelSettingsState.hasStoredSpeechMethod = false;
    modelSettingsState.speechSmartTurnSettings = {
      enabled: true,
      threshold: 0.95,
      timeoutMs: 3000,
    };
    modelSettingsState.speechMethod = YA_GROK_BATCH_SPEECH_METHOD;
    modelSettingsState.hasStoredSpeechMethod = true;

    render(
      <NewSessionForm
        projectId="project-1"
        selectedProject={chooserProjects[0]}
        projects={[...chooserProjects]}
      />,
    );

    fireEvent.contextMenu(screen.getByText("voice"));
    expect(
      screen.queryByRole("radio", {
        name: "Grok STT through YA batch",
      }),
    ).toBeNull();
    expect(
      screen
        .getByRole("radio", {
          name: "Grok STT direct",
        })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(screen.getByText("Smart Turn")).toBeDefined();

    fireEvent.click(
      screen.getByRole("radio", {
        name: "Grok STT through YA",
      }),
    );
    expect(mockSetSpeechMethod).toHaveBeenCalledWith("ya-grok");
  });

  it("shows Smart Turn for direct Grok streaming without server capabilities", () => {
    remoteBasePathState.basePath = "/ygraehl";
    versionState.version = {
      voiceBackends: ["ya-grok"],
      voiceBackendCapabilities: {},
    };
    modelSettingsState.speechMethod = XAI_DIRECT_STREAMING_SPEECH_METHOD;
    modelSettingsState.hasStoredSpeechMethod = true;
    modelSettingsState.speechSmartTurnSettings = {
      enabled: true,
      threshold: 0.95,
      timeoutMs: 3000,
    };

    render(
      <NewSessionForm
        projectId="project-1"
        selectedProject={chooserProjects[0]}
        projects={[...chooserProjects]}
      />,
    );

    fireEvent.contextMenu(screen.getByText("voice"));

    expect(screen.getByText("Smart Turn")).toBeDefined();
    expect(screen.queryByText("Grok STT audio")).toBeNull();
  });

  it("hides a stored YA-routed Grok batch method in relay mode", () => {
    remoteBasePathState.basePath = "/ygraehl";
    versionState.version = {
      voiceBackends: ["ya-grok"],
      voiceBackendCapabilities: {
        "ya-grok": { streaming: true, smartTurn: true },
      },
    };
    modelSettingsState.speechMethod = YA_GROK_BATCH_SPEECH_METHOD;
    modelSettingsState.hasStoredSpeechMethod = true;

    render(
      <NewSessionForm
        projectId="project-1"
        selectedProject={chooserProjects[0]}
        projects={[...chooserProjects]}
      />,
    );

    fireEvent.contextMenu(screen.getByText("voice"));

    expect(
      screen.queryByRole("radio", {
        name: "Grok STT through YA batch",
      }),
    ).toBeNull();
  });

  it("defaults prompt suggestions off when the provider lacks native support", async () => {
    serverSettingsState.isLoading = false;

    render(
      <NewSessionForm
        projectId="project-1"
        selectedProject={chooserProjects[0]}
        projects={[...chooserProjects]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Codex" }));
    expect(
      screen.getByRole("button", {
        name: /promptSuggestionModeNative/,
      }),
    ).toBeDefined();
    expect(screen.queryByText("promptSuggestionNativeUnsupported")).toBeNull();
    fireEvent.change(screen.getByPlaceholderText("newSessionPlaceholder"), {
      target: { value: "hello" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "newSessionStartAction" }),
    );

    await waitFor(() => {
      expect(mockStartSession).toHaveBeenCalledWith(
        "project-1",
        "hello",
        expect.objectContaining({
          provider: "codex",
          promptSuggestionMode: "off",
        }),
        undefined,
        expect.any(Number),
      );
    });
  });

  it("keeps native prompt suggestion preference across provider switches", async () => {
    serverSettingsState.settings = {
      newSessionDefaults: {
        provider: "claude",
        model: "opus",
        permissionMode: "default",
        promptSuggestionMode: "native",
      },
    };
    serverSettingsState.isLoading = false;

    render(
      <NewSessionForm
        projectId="project-1"
        selectedProject={chooserProjects[0]}
        projects={[...chooserProjects]}
      />,
    );

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /promptSuggestionModeNative/ })
          .className,
      ).toContain("selected");
    });

    fireEvent.click(screen.getByRole("button", { name: "Codex" }));

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /promptSuggestionModeNative/ })
          .className,
      ).toContain("selected");
    });
    expect(mockUpdateSetting).toHaveBeenCalledWith(
      "newSessionDefaults",
      expect.objectContaining({
        provider: "codex",
        promptSuggestionMode: "native",
      }),
    );
    fireEvent.change(screen.getByPlaceholderText("newSessionPlaceholder"), {
      target: { value: "hello" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "newSessionStartAction" }),
    );
    await waitFor(() => {
      expect(mockStartSession).toHaveBeenCalledWith(
        "project-1",
        "hello",
        expect.objectContaining({
          provider: "codex",
          promptSuggestionMode: "off",
        }),
        undefined,
        expect.any(Number),
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Claude" }));

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /promptSuggestionModeNative/ })
          .className,
      ).toContain("selected");
    });
  });

  it("keeps simulated recaps available when native suggestions are unsupported", async () => {
    serverSettingsState.isLoading = false;

    render(
      <NewSessionForm
        projectId="project-1"
        selectedProject={chooserProjects[0]}
        projects={[...chooserProjects]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Codex" }));
    expect(
      screen.getByRole("button", { name: /recapModeSideSession/ }),
    ).toBeDefined();
    expect(
      screen.queryByRole("button", { name: /recapModeNative/ }),
    ).toBeNull();
    expect(
      screen.getByRole("button", {
        name: /promptSuggestionModeNative/,
      }),
    ).toBeDefined();

    fireEvent.click(
      screen.getByRole("button", { name: /recapModeSideSession/ }),
    );
    fireEvent.change(screen.getByPlaceholderText("newSessionPlaceholder"), {
      target: { value: "hello" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "newSessionStartAction" }),
    );

    await waitFor(() => {
      expect(mockStartSession).toHaveBeenCalledWith(
        "project-1",
        "hello",
        expect.objectContaining({
          provider: "codex",
          recapMode: "side-session",
          promptSuggestionMode: "off",
        }),
        undefined,
        expect.any(Number),
      );
    });
  });

  it("hides configured helper targets until runtime support exists", async () => {
    serverSettingsState.settings = {
      helperTargets: [
        {
          id: "local-vllm",
          name: "Local vLLM",
          kind: "openai-compatible",
          baseUrl: "http://localhost:8001/v1",
          model: "Qwen/Qwen3.6-27B",
        },
      ],
    };
    serverSettingsState.isLoading = false;

    render(
      <NewSessionForm
        projectId="project-1"
        selectedProject={chooserProjects[0]}
        projects={[...chooserProjects]}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: /recapModeSideSession/ }),
    );
    expect(screen.queryByRole("button", { name: "Local vLLM" })).toBeNull();
    fireEvent.change(screen.getByPlaceholderText("newSessionPlaceholder"), {
      target: { value: "hello" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "newSessionStartAction" }),
    );

    await waitFor(() => {
      expect(mockStartSession).toHaveBeenCalledWith(
        "project-1",
        "hello",
        expect.objectContaining({
          recapMode: "side-session",
          helperSideModel: "cheapest",
        }),
        undefined,
        expect.any(Number),
      );
    });
  });
});
