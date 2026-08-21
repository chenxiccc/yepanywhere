import { execFileSync, execSync, spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Session file stores the path to the unique temp directory for this test run
// This is the only fixed-path file - everything else goes in the unique temp dir
const SESSION_FILE = join(tmpdir(), "claude-e2e-session");

// These will be set after creating the unique temp directory
let E2E_TEMP_DIR: string;
let PORT_FILE: string;
let MAINTENANCE_PORT_FILE: string;
let PID_FILE: string;
let REMOTE_CLIENT_PORT_FILE: string;
let REMOTE_CLIENT_PID_FILE: string;
let REMOTE_PREVIEW_PORT_FILE: string;
let REMOTE_PREVIEW_PID_FILE: string;
let RELAY_PORT_FILE: string;
let RELAY_PID_FILE: string;

// Isolated test directories to avoid polluting real ~/.claude, ~/.codex, ~/.gemini
let E2E_TEST_DIR: string;
let E2E_CLAUDE_SESSIONS_DIR: string;
let E2E_CODEX_SESSIONS_DIR: string;
let E2E_GEMINI_SESSIONS_DIR: string;
let E2E_DATA_DIR: string;

/**
 * Wait for a port file to be written with a valid port number.
 */
async function waitForPortFile(
  portFile: string,
  name: string,
  timeoutMs = 30000,
): Promise<number> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (existsSync(portFile)) {
      const content = readFileSync(portFile, "utf-8").trim();
      const port = Number.parseInt(content, 10);
      if (port > 0) {
        return port;
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timeout waiting for ${name} port file (${timeoutMs}ms)`);
}

function shouldStartRelay(): boolean {
  const setting = process.env.YEP_E2E_START_RELAY?.toLowerCase();
  return setting !== "0" && setting !== "false" && setting !== "no";
}

export default async function globalSetup() {
  const serverLogLevel = process.env.E2E_SERVER_LOG_LEVEL ?? "warn";
  const serverFileLogLevel =
    process.env.E2E_SERVER_FILE_LOG_LEVEL ?? serverLogLevel;

  // Create a unique temp directory for this test run
  // This prevents collisions between parallel test runs
  E2E_TEMP_DIR = mkdtempSync(join(tmpdir(), "claude-e2e-"));
  console.log(`[E2E] Using temp directory: ${E2E_TEMP_DIR}`);

  // Write session file so teardown can find our temp directory
  writeFileSync(SESSION_FILE, E2E_TEMP_DIR);

  // Set up file paths within the unique temp directory
  PORT_FILE = join(E2E_TEMP_DIR, "port");
  MAINTENANCE_PORT_FILE = join(E2E_TEMP_DIR, "maintenance-port");
  PID_FILE = join(E2E_TEMP_DIR, "pid");
  REMOTE_CLIENT_PORT_FILE = join(E2E_TEMP_DIR, "remote-port");
  REMOTE_CLIENT_PID_FILE = join(E2E_TEMP_DIR, "remote-pid");
  REMOTE_PREVIEW_PORT_FILE = join(E2E_TEMP_DIR, "remote-preview-port");
  REMOTE_PREVIEW_PID_FILE = join(E2E_TEMP_DIR, "remote-preview-pid");
  RELAY_PORT_FILE = join(E2E_TEMP_DIR, "relay-port");
  RELAY_PID_FILE = join(E2E_TEMP_DIR, "relay-pid");

  // Set up isolated test directories within the temp dir
  E2E_TEST_DIR = join(E2E_TEMP_DIR, "sessions");
  E2E_CLAUDE_SESSIONS_DIR = join(E2E_TEST_DIR, "claude", "projects");
  E2E_CODEX_SESSIONS_DIR = join(E2E_TEST_DIR, "codex", "sessions");
  E2E_GEMINI_SESSIONS_DIR = join(E2E_TEST_DIR, "gemini", "tmp");
  E2E_DATA_DIR = join(E2E_TEST_DIR, "yep-anywhere");

  // Create isolated test directories
  console.log(`[E2E] Creating isolated test directories at ${E2E_TEST_DIR}`);
  mkdirSync(E2E_CLAUDE_SESSIONS_DIR, { recursive: true });
  mkdirSync(E2E_CODEX_SESSIONS_DIR, { recursive: true });
  mkdirSync(E2E_GEMINI_SESSIONS_DIR, { recursive: true });
  mkdirSync(E2E_DATA_DIR, { recursive: true });
  writeFileSync(
    join(E2E_DATA_DIR, "server-settings.json"),
    JSON.stringify(
      {
        version: 1,
        settings: {
          codexUpdatePolicy: "off",
        },
      },
      null,
      2,
    ),
  );

  // Write paths file for tests to import
  const pathsFile = join(E2E_TEMP_DIR, "paths.json");
  writeFileSync(
    pathsFile,
    JSON.stringify({
      tempDir: E2E_TEMP_DIR,
      testDir: E2E_TEST_DIR,
      claudeSessionsDir: E2E_CLAUDE_SESSIONS_DIR,
      codexSessionsDir: E2E_CODEX_SESSIONS_DIR,
      geminiSessionsDir: E2E_GEMINI_SESSIONS_DIR,
      dataDir: E2E_DATA_DIR,
      portFile: PORT_FILE,
      maintenancePortFile: MAINTENANCE_PORT_FILE,
      pidFile: PID_FILE,
      remoteClientPortFile: REMOTE_CLIENT_PORT_FILE,
      remoteClientPidFile: REMOTE_CLIENT_PID_FILE,
      remotePreviewPortFile: REMOTE_PREVIEW_PORT_FILE,
      remotePreviewPidFile: REMOTE_PREVIEW_PID_FILE,
      relayPortFile: RELAY_PORT_FILE,
      relayPidFile: RELAY_PID_FILE,
    }),
  );

  // Create mock project data for tests that expect a session to exist
  const mockProjectPath = join(E2E_TEMP_DIR, "mockproject");
  mkdirSync(mockProjectPath, { recursive: true });
  writeFileSync(
    join(mockProjectPath, "GLOSSARY.md"),
    [
      "# Glossary",
      "",
      "| term | definition | references |",
      "| --- | --- | --- |",
      "| Viewer context | The active session's project context for a viewed file. | |",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(mockProjectPath, "turn-target.md"),
    "# User-turn link target\n",
  );
  const encodedPath = mockProjectPath.replace(/\//g, "-");
  const mockSessionDir = join(E2E_CLAUDE_SESSIONS_DIR, hostname(), encodedPath);
  mkdirSync(mockSessionDir, { recursive: true });
  const sessionFile = join(mockSessionDir, "mock-session-001.jsonl");
  const mockMessages = [
    {
      type: "user",
      cwd: mockProjectPath,
      message: { role: "user", content: "Previous message" },
      timestamp: new Date().toISOString(),
      uuid: "1",
    },
  ];
  writeFileSync(
    sessionFile,
    mockMessages.map((m) => JSON.stringify(m)).join("\n"),
  );
  console.log(`[E2E] Created mock session at ${sessionFile}`);

  const providerChildSessionId = "provider-child-layout-001";
  writeFileSync(
    join(mockSessionDir, `${providerChildSessionId}.jsonl`),
    mockMessages.map((message) => JSON.stringify(message)).join("\n"),
  );
  const providerChildDir = join(
    mockSessionDir,
    providerChildSessionId,
    "subagents",
  );
  mkdirSync(providerChildDir, { recursive: true });
  writeFileSync(
    join(providerChildDir, "agent-layout-child.jsonl"),
    [
      {
        type: "user",
        uuid: "provider-child-user-1",
        agentId: "layout-child",
        isSidechain: true,
        sessionId: providerChildSessionId,
        message: { content: "Inspect the provider child layout." },
      },
      {
        type: "assistant",
        uuid: "provider-child-assistant-1",
        parentUuid: "provider-child-user-1",
        agentId: "layout-child",
        isSidechain: true,
        message: {
          content: [
            {
              type: "text",
              text: "The compact title layout keeps the transcript visible.",
            },
          ],
        },
      },
      {
        type: "result",
        uuid: "provider-child-result-1",
        parentUuid: "provider-child-assistant-1",
      },
    ]
      .map((message) => JSON.stringify(message))
      .join("\n"),
  );
  writeFileSync(
    join(providerChildDir, "agent-layout-child.meta.json"),
    JSON.stringify({
      agentType: "Explore",
      description: "Inspect the provider child layout",
      spawnDepth: 1,
    }),
  );
  console.log("[E2E] Created provider child layout session");

  for (const speechSessionId of [
    "speech-caret-001",
    "speech-caret-002",
    "speech-caret-003",
    "speech-caret-004",
  ]) {
    writeFileSync(
      join(mockSessionDir, `${speechSessionId}.jsonl`),
      mockMessages.map((message) => JSON.stringify(message)).join("\n"),
    );
  }
  console.log("[E2E] Created isolated speech composer sessions");

  // Deterministic transcript specimen for semantic-boundary browser gates.
  // Keep it separate from mock-session-001 so transport/navigation tests that
  // expect the historical one-row fixture retain their exact input.
  const transcriptSpecimenFile = join(
    mockSessionDir,
    "transcript-specimen-001.jsonl",
  );
  const transcriptSpecimenMessages = [
    {
      type: "user",
      cwd: mockProjectPath,
      message: { role: "user", content: "Inspect the browser specimen" },
      timestamp: "2026-01-01T00:00:00.000Z",
      uuid: "specimen-user-1",
    },
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "I should inspect the fixture." },
          { type: "text", text: "I’ll read the file." },
          {
            type: "tool_use",
            id: "specimen-tool-1",
            name: "Read",
            input: { file_path: "fixture.ts" },
          },
        ],
      },
      timestamp: "2026-01-01T00:00:01.000Z",
      uuid: "specimen-assistant-1",
      parentUuid: "specimen-user-1",
    },
    {
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "specimen-tool-1",
            content: "export const fixture = true;",
          },
        ],
      },
      toolUseResult: { filePath: "fixture.ts", lineCount: 1 },
      timestamp: "2026-01-01T00:00:02.000Z",
      uuid: "specimen-result-1",
      parentUuid: "specimen-assistant-1",
    },
    {
      type: "system",
      subtype: "compact_boundary",
      content: "Context compacted",
      timestamp: "2026-01-01T00:00:03.000Z",
      uuid: "specimen-compact-1",
      parentUuid: "specimen-result-1",
    },
    {
      type: "assistant",
      message: { role: "assistant", content: "The specimen is ready." },
      timestamp: "2026-01-01T00:00:04.000Z",
      uuid: "specimen-assistant-2",
      parentUuid: "specimen-compact-1",
    },
  ];
  writeFileSync(
    transcriptSpecimenFile,
    transcriptSpecimenMessages
      .map((message) => JSON.stringify(message))
      .join("\n"),
  );
  console.log(`[E2E] Created transcript specimen at ${transcriptSpecimenFile}`);

  const userTurnPresentationFile = join(
    mockSessionDir,
    "user-turn-presentation-001.jsonl",
  );
  const userTurnPresentationMessages = [
    {
      type: "user",
      cwd: mockProjectPath,
      message: {
        role: "user",
        content:
          "Viewer context: inspect turn-target.md, then summarize the visible result and keep this deliberately long source sentence on one rendered desktop line.",
      },
      timestamp: "2026-01-03T00:00:00.000Z",
      uuid: "user-turn-presentation-1",
    },
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: "The short-width-dependent turn is complete.",
      },
      timestamp: "2026-01-03T00:00:01.000Z",
      uuid: "user-turn-presentation-assistant-1",
      parentUuid: "user-turn-presentation-1",
    },
    {
      type: "user",
      message: {
        role: "user",
        content: [
          "This turn is deliberately tall.",
          "Its visible lines contain the action rail.",
          "Line three keeps the bubble tall.",
          "Line four keeps the bubble tall.",
          "Line five keeps the bubble tall.",
          "Line six keeps the bubble tall.",
          "Line seven keeps the bubble tall.",
          "Line eight keeps the bubble tall.",
        ].join("\n"),
      },
      timestamp: "2026-01-03T00:00:02.000Z",
      uuid: "user-turn-presentation-2",
      parentUuid: "user-turn-presentation-assistant-1",
    },
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: "The explicitly tall turn is complete.",
      },
      timestamp: "2026-01-03T00:00:03.000Z",
      uuid: "user-turn-presentation-assistant-2",
      parentUuid: "user-turn-presentation-2",
    },
  ];
  writeFileSync(
    userTurnPresentationFile,
    userTurnPresentationMessages
      .map((message) => JSON.stringify(message))
      .join("\n"),
  );
  console.log(
    `[E2E] Created user-turn presentation fixture at ${userTurnPresentationFile}`,
  );

  const pageKeyPaginationFile = join(
    mockSessionDir,
    "page-key-pagination-001.jsonl",
  );
  const pageKeyPaginationMessages = Array.from({ length: 30 }, (_, index) => ({
    type: "user",
    ...(index === 0 ? { cwd: mockProjectPath } : {}),
    message: {
      role: "user",
      content:
        index === 0
          ? "Oldest keyboard request"
          : index === 10
            ? "Intermediate keyboard request"
            : index === 29
              ? "Current keyboard request"
              : `Keyboard request ${index + 1}`,
    },
    timestamp: `2026-01-02T00:00:${String(index).padStart(2, "0")}.000Z`,
    uuid: `page-key-user-${index + 1}`,
    ...(index > 0 ? { parentUuid: `page-key-user-${index}` } : {}),
  }));
  writeFileSync(
    pageKeyPaginationFile,
    pageKeyPaginationMessages
      .map((message) => JSON.stringify(message))
      .join("\n"),
  );
  console.log(
    `[E2E] Created page-key pagination fixture at ${pageKeyPaginationFile}`,
  );

  // Create the file-browser fixture before the server starts so its initial
  // project snapshot sees it even when no installed provider activates a
  // filesystem watcher (as on a clean CI runner).
  const fileBrowserProjectPath = join(E2E_TEMP_DIR, "file-browser-project");
  mkdirSync(join(fileBrowserProjectPath, "src"), { recursive: true });
  writeFileSync(
    join(fileBrowserProjectPath, "test.txt"),
    "Hello from test file!",
  );
  writeFileSync(
    join(fileBrowserProjectPath, "README.md"),
    [
      "# Test Project",
      "",
      "This is a **test** markdown file.",
      "",
      "Viewer context remains available while reviewing this file.",
      "",
      "## Scroll clearance specimen",
      "",
      ...Array.from(
        { length: 60 },
        (_, index) => `Scrollable paragraph ${index + 1}.`,
      ),
      "",
      "End of file viewer clearance specimen.",
    ].join("\n"),
  );
  writeFileSync(
    join(fileBrowserProjectPath, "src", "index.ts"),
    [
      'export const alpha = "first highlighted line";',
      'export const beta = "second highlighted line";',
      `export const wrapped = "wrapped-selection-start ${"0123456789 ".repeat(24)}wrapped-selection-end";`,
      'export const repeated = "same marker";',
      'export const repeatedAgain = "same marker";',
      "console.log(alpha, beta, wrapped, repeated, repeatedAgain);",
    ].join("\n"),
  );
  writeFileSync(join(fileBrowserProjectPath, "data.json"), '{"key": "value"}');
  writeFileSync(
    join(fileBrowserProjectPath, "hostile.html"),
    '<script>fetch("/api/processes", { headers: { "X-Yep-Anywhere": "true" } }).then(() => { document.title = "EXECUTED"; })</script>',
  );
  writeFileSync(
    join(fileBrowserProjectPath, "hostile.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg" onload="fetch(\'/api/processes\', { headers: { \'X-Yep-Anywhere\': \'true\' } })"><rect width="10" height="10"/></svg>',
  );
  const fileBrowserSessionDir = join(
    E2E_CLAUDE_SESSIONS_DIR,
    hostname(),
    fileBrowserProjectPath.replace(/[/\\:]/g, "-"),
  );
  mkdirSync(fileBrowserSessionDir, { recursive: true });
  writeFileSync(
    join(fileBrowserSessionDir, "e2e-file-test.jsonl"),
    JSON.stringify({
      type: "user",
      cwd: fileBrowserProjectPath,
      message: { role: "user", content: "test" },
    }),
  );
  console.log(
    `[E2E] Created file-browser fixture at ${fileBrowserProjectPath}`,
  );

  // A dedicated clean Git project keeps Source Control browser tests isolated
  // from fixtures that other specs intentionally mutate.
  const sourceControlProjectPath = join(E2E_TEMP_DIR, "source-control-project");
  mkdirSync(sourceControlProjectPath, { recursive: true });
  writeFileSync(
    join(sourceControlProjectPath, "README.md"),
    [
      "# Source Control browser fixture",
      "prefix/that/is/intentionally/long/enough/to/be/truncated/while/searching/ZebraNeedle/and/a/long/trailing/suffix/for/the/source/control/result",
      "",
    ].join("\n"),
  );
  execFileSync("git", ["init", "--initial-branch=main"], {
    cwd: sourceControlProjectPath,
    stdio: "ignore",
  });
  execFileSync("git", ["add", "README.md"], {
    cwd: sourceControlProjectPath,
    stdio: "ignore",
  });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=YA E2E",
      "-c",
      "user.email=ya-e2e@example.invalid",
      "commit",
      "-m",
      "Seed source control fixture",
    ],
    {
      cwd: sourceControlProjectPath,
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: "2026-01-03T00:00:00Z",
        GIT_COMMITTER_DATE: "2026-01-03T00:00:00Z",
      },
      stdio: "ignore",
    },
  );
  const sourceControlSessionDir = join(
    E2E_CLAUDE_SESSIONS_DIR,
    hostname(),
    sourceControlProjectPath.replace(/[/\\:]/g, "-"),
  );
  mkdirSync(sourceControlSessionDir, { recursive: true });
  writeFileSync(
    join(sourceControlSessionDir, "source-control-clean-001.jsonl"),
    JSON.stringify({
      type: "user",
      cwd: sourceControlProjectPath,
      message: { role: "user", content: "Inspect the clean repository" },
      timestamp: "2026-01-03T00:00:01.000Z",
      uuid: "source-control-user-1",
    }),
  );
  console.log(
    `[E2E] Created clean Source Control fixture at ${sourceControlProjectPath}`,
  );

  // This project must exist before the server assembles its project inventory.
  // The spec dirties the committed file after global setup.
  const sourceControlToolbarProjectPath = join(
    E2E_TEMP_DIR,
    "source-control-toolbar-project",
  );
  const sourceControlToolbarFileName =
    "claude-gateway-process-start-and-output-collector-with-an-intentionally-long-layout-name-that-wraps-at-medium-width.ts";
  const sourceControlToolbarRelativePath = `src/${sourceControlToolbarFileName}`;
  mkdirSync(join(sourceControlToolbarProjectPath, "src"), { recursive: true });
  writeFileSync(
    join(sourceControlToolbarProjectPath, sourceControlToolbarRelativePath),
    "export const toolbarLayoutFixture = false;\n",
  );
  execFileSync("git", ["init", "--initial-branch=main"], {
    cwd: sourceControlToolbarProjectPath,
    stdio: "ignore",
  });
  execFileSync("git", ["add", sourceControlToolbarRelativePath], {
    cwd: sourceControlToolbarProjectPath,
    stdio: "ignore",
  });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=YA E2E",
      "-c",
      "user.email=ya-e2e@example.invalid",
      "commit",
      "-m",
      "Seed toolbar layout fixture",
    ],
    { cwd: sourceControlToolbarProjectPath, stdio: "ignore" },
  );
  const sourceControlToolbarSessionDir = join(
    E2E_CLAUDE_SESSIONS_DIR,
    hostname(),
    sourceControlToolbarProjectPath.replace(/[/\\:]/g, "-"),
  );
  mkdirSync(sourceControlToolbarSessionDir, { recursive: true });
  writeFileSync(
    join(sourceControlToolbarSessionDir, "source-control-toolbar-001.jsonl"),
    JSON.stringify({
      type: "user",
      cwd: sourceControlToolbarProjectPath,
      message: { role: "user", content: "Inspect the diff toolbar layout" },
      timestamp: "2026-01-03T00:00:02.000Z",
      uuid: "source-control-toolbar-user-1",
    }),
  );
  console.log(
    `[E2E] Created Source Control toolbar fixture at ${sourceControlToolbarProjectPath}`,
  );

  // A separate dirty Quarto project exercises the rendered-document path
  // without changing the clean-landing fixture above.
  const sourceControlQmdProjectPath = join(
    E2E_TEMP_DIR,
    "source-control-qmd-project",
  );
  mkdirSync(join(sourceControlQmdProjectPath, "sections"), { recursive: true });
  writeFileSync(
    join(sourceControlQmdProjectPath, "sections", "_introduction.qmd"),
    "Included introduction.\n",
  );
  writeFileSync(
    join(sourceControlQmdProjectPath, "report.qmd"),
    [
      "---",
      "title: Initial report",
      "---",
      "",
      "# Initial Quarto report",
      "",
      "{{< include sections/_introduction.qmd >}}",
      "",
    ].join("\n"),
  );
  execFileSync("git", ["init", "--initial-branch=main"], {
    cwd: sourceControlQmdProjectPath,
    stdio: "ignore",
  });
  execFileSync("git", ["add", "report.qmd", "sections/_introduction.qmd"], {
    cwd: sourceControlQmdProjectPath,
    stdio: "ignore",
  });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=YA E2E",
      "-c",
      "user.email=ya-e2e@example.invalid",
      "commit",
      "-m",
      "Seed Quarto source control fixture",
    ],
    {
      cwd: sourceControlQmdProjectPath,
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: "2026-01-04T00:00:00Z",
        GIT_COMMITTER_DATE: "2026-01-04T00:00:00Z",
      },
      stdio: "ignore",
    },
  );
  writeFileSync(
    join(sourceControlQmdProjectPath, "report.qmd"),
    [
      "---",
      "title: Updated report",
      "---",
      "",
      "# Updated Quarto report",
      "",
      "{{< include sections/_introduction.qmd >}}",
      "",
    ].join("\n"),
  );
  const sourceControlQmdSessionDir = join(
    E2E_CLAUDE_SESSIONS_DIR,
    hostname(),
    sourceControlQmdProjectPath.replace(/[/\\:]/g, "-"),
  );
  mkdirSync(sourceControlQmdSessionDir, { recursive: true });
  writeFileSync(
    join(sourceControlQmdSessionDir, "source-control-qmd-001.jsonl"),
    JSON.stringify({
      type: "user",
      cwd: sourceControlQmdProjectPath,
      message: { role: "user", content: "Inspect the Quarto report" },
      timestamp: "2026-01-04T00:00:01.000Z",
      uuid: "source-control-qmd-user-1",
    }),
  );
  console.log(
    `[E2E] Created Quarto Source Control fixture at ${sourceControlQmdProjectPath}`,
  );

  const absoluteViewerSessionFile = join(
    mockSessionDir,
    "file-viewer-absolute-001.jsonl",
  );
  const externalReadmePath = join(fileBrowserProjectPath, "README.md");
  writeFileSync(
    absoluteViewerSessionFile,
    [
      {
        type: "user",
        cwd: mockProjectPath,
        message: { role: "user", content: "Open the external reference" },
        timestamp: "2026-01-02T00:00:00.000Z",
        uuid: "viewer-user-1",
      },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: `Review ${externalReadmePath} and quote the relevant passage.`,
        },
        timestamp: "2026-01-02T00:00:01.000Z",
        uuid: "viewer-assistant-1",
        parentUuid: "viewer-user-1",
      },
    ]
      .map((message) => JSON.stringify(message))
      .join("\n"),
  );
  console.log(
    `[E2E] Created absolute-path viewer session at ${absoluteViewerSessionFile}`,
  );

  const sourceSelectionSessionFile = join(
    mockSessionDir,
    "source-selection-001.jsonl",
  );
  const externalSourcePath = join(fileBrowserProjectPath, "src", "index.ts");
  writeFileSync(
    sourceSelectionSessionFile,
    [
      {
        type: "user",
        cwd: mockProjectPath,
        message: { role: "user", content: "Review the formatted source" },
        timestamp: "2026-01-02T00:01:00.000Z",
        uuid: "source-selection-user-1",
      },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: `Review ${externalSourcePath} and quote the exact source range.`,
        },
        timestamp: "2026-01-02T00:01:01.000Z",
        uuid: "source-selection-assistant-1",
        parentUuid: "source-selection-user-1",
      },
    ]
      .map((message) => JSON.stringify(message))
      .join("\n"),
  );

  const activitySelectionSessionFile = join(
    mockSessionDir,
    "activity-selection-001.jsonl",
  );
  const activityOutput = [
    `selection anchor near top ${"wide-output ".repeat(20)}`,
    ...Array.from(
      { length: 70 },
      (_, index) => `activity output line ${index + 2}`,
    ),
  ].join("\n");
  writeFileSync(
    activitySelectionSessionFile,
    [
      {
        type: "user",
        cwd: mockProjectPath,
        message: { role: "user", content: "Inspect the long activity output" },
        timestamp: "2026-01-02T00:02:00.000Z",
        uuid: "activity-selection-user-1",
      },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "activity-selection-bash-1",
              name: "Bash",
              input: {
                command: "generate-selection-output",
                description: "Selection placement specimen",
              },
            },
          ],
        },
        timestamp: "2026-01-02T00:02:01.000Z",
        uuid: "activity-selection-assistant-1",
        parentUuid: "activity-selection-user-1",
      },
      {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "activity-selection-bash-1",
              content: activityOutput,
            },
          ],
        },
        toolUseResult: {
          stdout: activityOutput,
          stderr: "",
          interrupted: false,
          isImage: false,
          exitCode: 0,
        },
        timestamp: "2026-01-02T00:02:02.000Z",
        uuid: "activity-selection-result-1",
        parentUuid: "activity-selection-assistant-1",
      },
    ]
      .map((message) => JSON.stringify(message))
      .join("\n"),
  );

  const repoRoot = join(__dirname, "..", "..", "..");
  const serverRoot = join(repoRoot, "packages", "server");
  const clientDist = join(repoRoot, "packages", "client", "dist");
  const remoteClientDist = join(repoRoot, "packages", "client", "dist-remote");

  // Build shared first (client depends on it), then client
  console.log("[E2E] Building shared package...");
  execSync("pnpm --filter @yep-anywhere/shared build", {
    cwd: repoRoot,
    stdio: "inherit",
  });

  console.log("[E2E] Building client...");
  execSync("pnpm --filter @yep-anywhere/client build", {
    cwd: repoRoot,
    env: {
      ...process.env,
      // Global first-run overlays are outside this suite's contracts and can
      // arrive after a page-specific readiness check, obscuring its controls.
      VITE_DISABLE_CLI_UPDATE_NOTIFICATIONS: "true",
      VITE_DISABLE_ONBOARDING: "true",
      VITE_E2E_SOURCE_TRANSPORT_SMOKE: "true",
    },
    stdio: "inherit",
  });

  console.log("[E2E] Building remote client production preview...");
  execSync(
    "pnpm --filter @yep-anywhere/client exec vite build --config vite.config.remote.ts --base /",
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        VITE_DISABLE_CLI_UPDATE_NOTIFICATIONS: "true",
        VITE_DISABLE_ONBOARDING: "true",
      },
      stdio: "inherit",
    },
  );
  copyFileSync(
    join(remoteClientDist, "remote.html"),
    join(remoteClientDist, "index.html"),
  );

  if (shouldStartRelay()) {
    // Start relay server for relay integration tests
    const relayDataDir = join(E2E_TEST_DIR, "relay");
    mkdirSync(relayDataDir, { recursive: true });

    console.log("[E2E] Starting relay server...");
    const relayRoot = join(repoRoot, "packages", "relay");
    const relayProcess = spawn(
      "pnpm",
      ["exec", "tsx", "--conditions", "source", "src/index.ts"],
      {
        cwd: relayRoot,
        env: {
          ...process.env,
          RELAY_PORT: "0", // Auto-assign port
          RELAY_PORT_FILE: RELAY_PORT_FILE,
          RELAY_DATA_DIR: relayDataDir,
          RELAY_ALLOWED_ORIGINS: "*",
          RELAY_LOG_LEVEL: "warn", // Reduce noise, port comes from file
          RELAY_LOG_TO_FILE: "false",
          // Large logical responses and uploads must use bounded application
          // frames rather than depending on the relay's parser allowance.
          RELAY_WEBSOCKET_MAX_MESSAGE_BYTES: String(1024 * 1024),
          // The multi-host matrix deliberately remounts the same three targets
          // seven times in under a minute. Raw relay tests cover the production
          // per-target default; keep the browser lifecycle matrix below its
          // own higher test-only ceiling.
          RELAY_MUX_OPEN_ATTEMPTS_PER_MINUTE_PER_IP_USERNAME: "20",
        },
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      },
    );

    if (relayProcess.pid) {
      writeFileSync(RELAY_PID_FILE, String(relayProcess.pid));
    }

    // Log stderr for debugging
    relayProcess.stderr?.on("data", (data: Buffer) => {
      const msg = data.toString();
      if (!msg.includes("ExperimentalWarning")) {
        console.error("[E2E Relay]", msg);
      }
    });

    relayProcess.on("error", (err) => {
      console.error("[E2E Relay] Process error:", err);
    });

    // Wait for port file
    const relayPort = await waitForPortFile(
      RELAY_PORT_FILE,
      "relay server",
      30000,
    );
    console.log(`[E2E] Relay server on port ${relayPort}`);
    relayProcess.unref();
  } else {
    console.log(
      "[E2E] Skipping relay server startup (YEP_E2E_START_RELAY disabled)",
    );
  }

  // Start main server with PORT_FILE for port reporting
  console.log("[E2E] Starting main server...");
  const serverProcess = spawn(
    "pnpm",
    ["exec", "tsx", "--conditions", "source", "src/index.ts"],
    {
      cwd: serverRoot,
      env: {
        ...process.env,
        PORT: "0",
        PORT_FILE: PORT_FILE,
        MAINTENANCE_PORT: "-1", // Auto-assign
        MAINTENANCE_PORT_FILE: MAINTENANCE_PORT_FILE,
        SERVE_FRONTEND: "true",
        CLIENT_DIST_PATH: clientDist,
        LOG_FILE: "e2e-server.log",
        LOG_LEVEL: serverLogLevel, // Override in targeted tests when log assertions are needed.
        LOG_FILE_LEVEL: serverFileLogLevel,
        AUTH_DISABLED: "true",
        HTTPS_SELF_SIGNED: "", // force HTTP so health check URL works
        NODE_ENV: "production",
        CLAUDE_SESSIONS_DIR: E2E_CLAUDE_SESSIONS_DIR,
        CODEX_SESSIONS_DIR: E2E_CODEX_SESSIONS_DIR,
        GEMINI_SESSIONS_DIR: E2E_GEMINI_SESSIONS_DIR,
        YEP_DATA_DIR: E2E_DATA_DIR,
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    },
  );

  if (serverProcess.pid) {
    writeFileSync(PID_FILE, String(serverProcess.pid));
  }

  // Log stderr for debugging
  serverProcess.stderr?.on("data", (data: Buffer) => {
    const msg = data.toString();
    if (!msg.includes("ExperimentalWarning")) {
      console.error("[E2E Server]", msg);
    }
  });

  serverProcess.on("error", (err) => {
    console.error("[E2E Server] Process error:", err);
  });

  // Wait for both port files
  const [mainPort, maintenancePort] = await Promise.all([
    waitForPortFile(PORT_FILE, "main server", 30000),
    waitForPortFile(MAINTENANCE_PORT_FILE, "maintenance server", 30000),
  ]);
  console.log(`[E2E] Server started on port ${mainPort}`);
  console.log(`[E2E] Maintenance server on port ${maintenancePort}`);

  // Health check: wait for server to be ready
  const healthCheckUrl = `http://localhost:${mainPort}/health`;
  let attempts = 0;
  const maxAttempts = 30;
  while (attempts < maxAttempts) {
    try {
      const response = await fetch(healthCheckUrl);
      if (response.ok) {
        console.log("[E2E] Server health check passed");
        break;
      }
    } catch {
      // Server not ready yet
    }
    attempts++;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (attempts >= maxAttempts) {
    throw new Error("Server health check failed after 30 attempts");
  }

  serverProcess.unref();

  // Keep the source-enabled development server for tests that install browser
  // fixtures by importing modules directly from /src.
  console.log("[E2E] Starting remote client development server...");
  const remoteClientProcess = spawn(
    "pnpm",
    ["exec", "tsx", "--conditions", "source", "e2e/start-vite-remote.ts"],
    {
      cwd: join(repoRoot, "packages", "client"),
      env: {
        ...process.env,
        VITE_PORT_FILE: REMOTE_CLIENT_PORT_FILE,
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    },
  );

  if (remoteClientProcess.pid) {
    writeFileSync(REMOTE_CLIENT_PID_FILE, String(remoteClientProcess.pid));
  }

  // Log stderr for debugging
  remoteClientProcess.stderr?.on("data", (data: Buffer) => {
    const msg = data.toString();
    if (!msg.includes("ExperimentalWarning")) {
      console.error("[E2E Remote Client]", msg);
    }
  });

  remoteClientProcess.on("error", (err) => {
    console.error("[E2E Remote Client] Process error:", err);
  });

  // Wait for port file
  const remotePort = await waitForPortFile(
    REMOTE_CLIENT_PORT_FILE,
    "remote client",
    30000,
  );
  console.log(`[E2E] Remote client development server on port ${remotePort}`);
  remoteClientProcess.unref();

  // Startup behavior depends on generated chunks, so expose the separately
  // built remote client through a production preview for that contract alone.
  console.log("[E2E] Starting remote client production preview...");
  const remotePreviewProcess = spawn(
    "pnpm",
    [
      "exec",
      "tsx",
      "--conditions",
      "source",
      "e2e/start-vite-remote-preview.ts",
    ],
    {
      cwd: join(repoRoot, "packages", "client"),
      env: {
        ...process.env,
        VITE_PORT_FILE: REMOTE_PREVIEW_PORT_FILE,
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    },
  );

  if (remotePreviewProcess.pid) {
    writeFileSync(REMOTE_PREVIEW_PID_FILE, String(remotePreviewProcess.pid));
  }

  remotePreviewProcess.stderr?.on("data", (data: Buffer) => {
    const msg = data.toString();
    if (!msg.includes("ExperimentalWarning")) {
      console.error("[E2E Remote Preview]", msg);
    }
  });

  remotePreviewProcess.on("error", (err) => {
    console.error("[E2E Remote Preview] Process error:", err);
  });

  const remotePreviewPort = await waitForPortFile(
    REMOTE_PREVIEW_PORT_FILE,
    "remote preview",
    30000,
  );
  console.log(
    `[E2E] Remote client production preview on port ${remotePreviewPort}`,
  );
  remotePreviewProcess.unref();
}

// Export session file path for teardown
export { SESSION_FILE };
