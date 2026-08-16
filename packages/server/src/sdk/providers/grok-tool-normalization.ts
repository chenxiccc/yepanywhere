/**
 * Grok Build tool normalization shared by the live ACP stream and persisted
 * updates.jsonl replay.
 *
 * Grok 0.2.112 added a versioned `_meta["x.ai/tool"]` envelope whose label,
 * native name, rich kind, and projected input remain stable while the generic
 * ACP kind/title may change over one tool-call lifecycle. Merge this state by
 * tool-call id before selecting a YA renderer. Grok 1.0.4 keeps that envelope
 * (schema version 1) and adds video, goal, workflow, monitor, and LSP kinds.
 */

export interface GrokCanonicalToolMeta {
  input?: Record<string, unknown>;
  kind: string;
  label: string;
  name: string;
  namespace: string;
  readOnly: boolean;
  version: number;
}

export interface NormalizedGrokToolState {
  input: Record<string, unknown>;
  meta?: GrokCanonicalToolMeta;
  name: string;
  nativeName?: string;
}

export interface GrokToolResultMediaCandidate {
  filename?: string;
  originalPath: string;
}

type GrokToolUpdate = Record<string, unknown>;

const VARIANT_TO_NATIVE_NAME: Record<string, string> = {
  AskUserQuestion: "ask_user_question",
  Bash: "run_terminal_command",
  EnterPlanMode: "enter_plan_mode",
  ExitPlanMode: "exit_plan_mode",
  Grep: "grep",
  ImageEdit: "image_edit",
  ImageGen: "image_gen",
  KillTask: "kill_command_or_subagent",
  ListDir: "list_dir",
  ReadFile: "read_file",
  SearchReplace: "search_replace",
  Task: "spawn_subagent",
  TaskOutput: "get_command_or_subagent_output",
  TodoWrite: "todo_write",
  UpdateGoal: "update_goal",
  VideoGen: "video_gen",
  ImageToVideo: "image_to_video",
  ReferenceToVideo: "reference_to_video",
  WebFetch: "web_fetch",
  WebSearch: "web_search",
  Workflow: "workflow",
  Write: "write",
};

const NATIVE_TOOL_NAMES = new Set(Object.values(VARIANT_TO_NATIVE_NAME));

export function normalizeGrokToolUpdate(
  update: GrokToolUpdate,
  previous?: NormalizedGrokToolState,
): NormalizedGrokToolState {
  const meta = parseCanonicalToolMeta(update) ?? previous?.meta;
  const rawInput = asRecord(update.rawInput);
  const rawOutput = asRecord(update.rawOutput);
  const variant = stringField(rawInput, "variant");
  const title = stringField(update, "title");
  const nativeName =
    meta?.name ??
    (variant ? VARIANT_TO_NATIVE_NAME[variant] : undefined) ??
    nativeNameFromTitle(title) ??
    previous?.nativeName;
  const name = rendererName(meta?.label, nativeName, meta?.kind, update);
  const input: Record<string, unknown> = {
    ...(previous?.input ?? {}),
    ...(meta?.input ?? {}),
  };

  normalizeCanonicalInput(input, nativeName, rawInput, rawOutput, update);

  if (meta) {
    input.grokTool = {
      version: meta.version,
      name: meta.name,
      kind: meta.kind,
      namespace: meta.namespace,
      label: meta.label,
      read_only: meta.readOnly,
      ...(meta.input ? { input: meta.input } : {}),
    };
  }
  const acpKind = stringField(update, "kind");
  const status = stringField(update, "status");
  if (acpKind) input.kind = acpKind;
  if (title) input.title = title;
  if (status) input.status = status;
  if (Array.isArray(update.locations)) input.locations = update.locations;
  if (update.rawInput !== undefined) input.rawInput = update.rawInput;
  if (update.content !== undefined) input.content = update.content;

  return { input, meta, name, nativeName };
}

export function hasGrokToolUseMetadata(update: GrokToolUpdate): boolean {
  return (
    parseCanonicalToolMeta(update) !== undefined ||
    stringField(update, "kind") !== undefined ||
    stringField(update, "title") !== undefined ||
    stringField(update, "status") !== undefined ||
    Array.isArray(update.locations) ||
    update.rawInput !== undefined ||
    update.content !== undefined
  );
}

export function isTerminalGrokToolUpdate(update: GrokToolUpdate): boolean {
  const status = stringField(update, "status");
  return (
    status === "completed" ||
    status === "failed" ||
    stringField(update, "error") !== undefined
  );
}

export function buildGrokStructuredToolResult(
  update: GrokToolUpdate,
  state?: NormalizedGrokToolState,
): unknown {
  const error = stringField(update, "error");
  if (error) return error;

  const rawOutput = asRecord(update.rawOutput);
  if (!rawOutput) {
    return update.content ?? stringField(update, "status") ?? "completed";
  }

  switch (rawOutput.type) {
    case "Bash":
      return buildBashResult(rawOutput);
    case "BackgroundTaskStarted":
      return buildBackgroundCommandResult(rawOutput);
    case "ReadFile":
      return buildReadResult(rawOutput, update, state?.input);
    case "GrepSearch":
      return buildGrepResult(rawOutput, state?.input);
    case "Todo":
      return buildTodoResult(rawOutput);
    case "SearchReplace":
      return state?.name === "Write"
        ? buildWriteResult(rawOutput, update, state.input)
        : buildEditResult(rawOutput, update, state?.input);
    case "WebFetch":
      return buildWebFetchResult(rawOutput, state?.input);
    case "AskUserQuestion":
      return buildAskUserQuestionResult(rawOutput, state?.input);
    case "ExitPlanMode":
      return buildExitPlanModeResult(rawOutput);
    case "ImageGen":
    case "ImageEdit":
    case "VideoGen":
    case "ImageToVideo":
    case "ReferenceToVideo":
      return buildImageResult(rawOutput);
    case "Text":
      return buildTextToolResult(rawOutput, state);
    case "KillTask":
      return asRecord(rawOutput.Result) ?? rawOutput;
    case "TaskOutput":
      return rawOutput;
    case "EnterPlanMode":
      return asRecord(rawOutput.Entered) ?? rawOutput;
    case "ListDir":
      return asRecord(rawOutput.Content) ?? rawOutput;
    default:
      if (isBackendWebSearchResult(rawOutput)) {
        return buildWebSearchResult(rawOutput);
      }
      return update.rawOutput;
  }
}

export function formatGrokToolResultContent(
  update: GrokToolUpdate,
  state?: NormalizedGrokToolState,
): string {
  const error = stringField(update, "error");
  if (error) return error;

  const rawOutput = asRecord(update.rawOutput);
  if (!rawOutput) {
    return (
      resultContentText(update) ??
      (typeof update.rawOutput === "string" ? update.rawOutput : undefined) ??
      stringField(update, "status") ??
      "completed"
    );
  }

  switch (rawOutput.type) {
    case "ReadFile":
      return `Read ${readFilePath(rawOutput, update, state?.input) || "file"}`;
    case "SearchReplace": {
      const applied = asRecord(rawOutput.EditsApplied);
      return (
        stringField(applied, "tool_output_for_prompt_concise") ??
        stringField(applied, "tool_output_for_prompt") ??
        "File updated"
      );
    }
    case "Todo":
      return (
        stringField(asRecord(rawOutput.TodosUpdated), "summary_for_prompt") ??
        "Todos updated"
      );
    case "GrepSearch":
      return decodeByteArray(rawOutput.stdout) ?? "Search completed";
    case "Bash":
      return (
        decodeByteArray(rawOutput.output) ??
        stringField(rawOutput, "output_for_prompt") ??
        "Command completed"
      );
    case "BackgroundTaskStarted":
      return (
        stringField(rawOutput, "summary") ??
        `Background task ${stringField(rawOutput, "task_id") ?? ""} started`
      ).trim();
    case "ListDir":
      return (
        stringField(asRecord(rawOutput.Content), "content") ??
        "Directory listed"
      );
    case "WebFetch":
      return `Fetched ${
        stringField(asRecord(rawOutput.Content), "url") ??
        stringField(state?.input, "url") ??
        "web page"
      }`;
    case "AskUserQuestion":
      return (
        stringField(asRecord(rawOutput.UserAnswered), "message") ??
        "Question answered"
      );
    case "EnterPlanMode":
      return "Plan mode entered";
    case "ExitPlanMode":
      return "Plan ready";
    case "ImageGen":
    case "ImageEdit":
      return `${rawOutput.type === "ImageEdit" ? "Edited" : "Generated"} image ${
        stringField(rawOutput, "filename") ?? ""
      }`.trim();
    case "VideoGen":
    case "ImageToVideo":
    case "ReferenceToVideo":
      return `Generated video ${stringField(rawOutput, "filename") ?? ""}`.trim();
    case "Text":
      return stringField(rawOutput, "text") ?? "Task started";
    case "TaskOutput":
      return taskOutputSummary(rawOutput) ?? "Task output retrieved";
    case "KillTask":
      return (
        stringField(asRecord(rawOutput.Result), "message") ?? "Task stopped"
      );
    default:
      if (isBackendWebSearchResult(rawOutput)) {
        const action = asRecord(rawOutput.action);
        return `Searched the web for ${
          stringField(action, "query") ?? "query"
        }`;
      }
      return resultContentText(update) ?? JSON.stringify(rawOutput);
  }
}

export function grokToolResultMediaCandidate(
  update: GrokToolUpdate,
): GrokToolResultMediaCandidate | undefined {
  const rawOutput = asRecord(update.rawOutput);
  if (rawOutput?.type !== "ImageGen" && rawOutput?.type !== "ImageEdit") {
    return undefined;
  }
  const originalPath = stringField(rawOutput, "path");
  if (!originalPath) return undefined;
  return {
    originalPath,
    ...(stringField(rawOutput, "filename")
      ? { filename: stringField(rawOutput, "filename") }
      : {}),
  };
}

function parseCanonicalToolMeta(
  update: GrokToolUpdate,
): GrokCanonicalToolMeta | undefined {
  const envelope = asRecord(asRecord(update._meta)?.["x.ai/tool"]);
  const version = numberField(envelope, "version");
  const name = stringField(envelope, "name");
  const kind = stringField(envelope, "kind");
  const namespace = stringField(envelope, "namespace");
  const label = stringField(envelope, "label");
  const readOnly = envelope?.read_only;
  const input = asRecord(envelope?.input);
  if (
    version === undefined ||
    !name ||
    !kind ||
    !namespace ||
    !label ||
    typeof readOnly !== "boolean"
  ) {
    return undefined;
  }
  return {
    version,
    name,
    kind,
    namespace,
    label,
    readOnly,
    ...(input ? { input } : {}),
  };
}

function nativeNameFromTitle(title: string | undefined): string | undefined {
  if (!title) return undefined;
  if (NATIVE_TOOL_NAMES.has(title)) return title;
  if (title === "write_file") return "write_file";
  if (title === "Web search:") return "web_search";
  return undefined;
}

function rendererName(
  label: string | undefined,
  nativeName: string | undefined,
  kind: string | undefined,
  update: GrokToolUpdate,
): string {
  if (nativeName === "todo_write") return "TodoWrite";
  if (nativeName === "grep") return "Grep";
  if (nativeName === "list_dir") return "list_dir";
  if (nativeName === "spawn_subagent") return "spawn_agent";
  if (nativeName === "get_command_or_subagent_output") {
    return "get_command_or_subagent_output";
  }
  if (nativeName === "kill_command_or_subagent") {
    return "kill_command_or_subagent";
  }
  if (nativeName === "enter_plan_mode") return "enter_plan_mode";
  if (nativeName === "image_gen") return "ImageGen";
  if (nativeName === "image_edit") return "ImageEdit";
  if (nativeName === "image_to_video") return "ImageToVideo";
  if (nativeName === "reference_to_video") return "ReferenceToVideo";
  if (nativeName === "video_gen") return "VideoGen";
  if (nativeName === "update_goal") return "update_goal";
  if (nativeName === "workflow") return "workflow";
  if (nativeName === "monitor") return "monitor";

  const byLabel: Record<string, string> = {
    "Ask User": "AskUserQuestion",
    "Code Intelligence": "lsp",
    Edit: "Edit",
    "Exit Plan Mode": "ExitPlanMode",
    "Generate Video":
      nativeName === "reference_to_video"
        ? "ReferenceToVideo"
        : nativeName === "video_gen"
          ? "VideoGen"
          : "ImageToVideo",
    Monitor: "monitor",
    Read: "Read",
    "Run Command": "Bash",
    "Update Goal": "update_goal",
    "Web Fetch": "WebFetch",
    "Web Search": "WebSearch",
    Workflow: "workflow",
    Write: "Write",
  };
  if (label && byLabel[label]) return byLabel[label];

  if (nativeName === "read_file") return "Read";
  if (nativeName === "run_terminal_command") return "Bash";
  if (nativeName === "search_replace") return "Edit";
  if (nativeName === "write" || nativeName === "write_file") return "Write";
  if (nativeName === "web_search") return "WebSearch";
  if (nativeName === "web_fetch") return "WebFetch";
  if (nativeName === "ask_user_question") return "AskUserQuestion";
  if (nativeName === "exit_plan_mode") return "ExitPlanMode";

  const acpKind = stringField(update, "kind");
  const fallbackKind = kind ?? acpKind;
  const byKind: Record<string, string> = {
    delete: "Delete",
    edit: "Edit",
    execute: "Bash",
    fetch: "WebFetch",
    move: "Move",
    read: "Read",
    search: "Search",
    web_fetch: "WebFetch",
    web_search: "WebSearch",
    write: "Write",
  };
  return (
    (fallbackKind ? byKind[fallbackKind] : undefined) ??
    nativeName ??
    label ??
    stringField(update, "title") ??
    "GrokTool"
  );
}

function normalizeCanonicalInput(
  input: Record<string, unknown>,
  nativeName: string | undefined,
  rawInput: Record<string, unknown> | undefined,
  rawOutput: Record<string, unknown> | undefined,
  update: GrokToolUpdate,
): void {
  const firstPath = firstLocationPath(update);
  switch (nativeName) {
    case "read_file": {
      const filePath =
        firstString(rawInput, ["target_file", "file_path", "path"]) ??
        stringField(input, "path") ??
        firstPath;
      if (filePath) input.file_path = filePath;
      copyNumber(rawInput, input, "offset");
      copyNumber(rawInput, input, "limit");
      break;
    }
    case "run_terminal_command":
      copyRawString(rawInput, input, "command");
      copyString(rawInput, input, "description");
      copyNumber(rawInput, input, "timeout");
      if (typeof rawInput?.background === "boolean") {
        input.run_in_background = rawInput.background;
      } else if (typeof rawInput?.is_background === "boolean") {
        input.run_in_background = rawInput.is_background;
      }
      break;
    case "grep":
      copyString(rawInput, input, "pattern");
      copyString(rawInput, input, "path");
      copyString(rawInput, input, "glob");
      copyString(rawInput, input, "output_mode");
      copyNumber(rawInput, input, "head_limit");
      break;
    case "search_replace":
      input.file_path =
        firstString(rawInput, ["file_path", "path"]) ??
        stringField(input, "path") ??
        firstPath ??
        input.file_path;
      copyRawString(rawInput, input, "old_string");
      copyRawString(rawInput, input, "new_string");
      if (typeof rawInput?.replace_all === "boolean") {
        input.replace_all = rawInput.replace_all;
      }
      break;
    case "write":
    case "write_file":
      input.file_path =
        firstString(rawInput, ["file_path", "path"]) ??
        stringField(input, "path") ??
        firstPath ??
        input.file_path;
      copyRawString(rawInput, input, "content");
      break;
    case "todo_write": {
      const outputTodos = normalizeTodos(
        asRecord(rawOutput?.TodosUpdated)?.todos,
      );
      const todos =
        outputTodos.length > 0 ? outputTodos : normalizeTodos(rawInput?.todos);
      if (todos.length > 0) input.todos = todos;
      break;
    }
    case "list_dir":
      input.target_directory =
        firstString(rawInput, ["target_directory", "directory", "path"]) ??
        stringField(input, "directory") ??
        firstPath ??
        input.target_directory;
      break;
    case "web_search":
      input.query =
        stringField(rawInput, "query") ??
        stringField(asRecord(rawOutput?.action), "query") ??
        input.query ??
        "";
      break;
    case "web_fetch":
      input.url =
        stringField(rawInput, "url") ??
        stringField(asRecord(rawOutput?.Content), "url") ??
        input.url ??
        "";
      input.prompt = stringField(rawInput, "prompt") ?? input.prompt ?? "";
      break;
    case "spawn_subagent":
      copyString(rawInput, input, "description");
      copyRawString(rawInput, input, "prompt");
      copyString(rawInput, input, "subagent_type");
      copyString(rawInput, input, "capability_mode");
      if (typeof rawInput?.background === "boolean") {
        input.run_in_background = rawInput.background;
      }
      if (typeof rawInput?.run_in_background === "boolean") {
        input.run_in_background = rawInput.run_in_background;
      }
      break;
    case "get_command_or_subagent_output": {
      if (Array.isArray(rawInput?.task_ids)) input.task_ids = rawInput.task_ids;
      const firstTaskId = stringArray(rawInput?.task_ids)[0];
      if (firstTaskId) input.task_id = firstTaskId;
      const timeoutMs = numberField(rawInput, "timeout_ms");
      if (timeoutMs !== undefined) {
        input.timeout = timeoutMs;
        input.block = timeoutMs > 0;
      }
      break;
    }
    case "kill_command_or_subagent":
      copyString(rawInput, input, "task_id");
      break;
    case "ask_user_question": {
      const questions = normalizeQuestions(rawInput?.questions);
      if (questions.length > 0) input.questions = questions;
      break;
    }
    case "exit_plan_mode": {
      const ready = asRecord(rawOutput?.PlanReady);
      const plan = rawStringField(ready, "plan_content");
      const filePath = stringField(ready, "plan_file_path");
      if (plan) input.plan = plan;
      if (filePath) input.file_path = filePath;
      break;
    }
    case "image_gen":
    case "image_edit":
    case "image_to_video":
    case "reference_to_video":
    case "video_gen":
      copyString(rawInput, input, "prompt");
      copyString(rawInput, input, "aspect_ratio");
      copyString(rawInput, input, "resolution_name");
      copyNumber(rawInput, input, "duration");
      if (Array.isArray(rawInput?.image)) input.image = rawInput.image;
      if (Array.isArray(rawInput?.images)) input.images = rawInput.images;
      if (rawOutput) {
        copyString(rawOutput, input, "path");
        copyString(rawOutput, input, "filename");
        copyString(rawOutput, input, "session_folder");
        copyString(rawOutput, input, "uploaded_url");
      }
      break;
    case "update_goal":
      copyString(rawInput, input, "objective");
      copyString(rawInput, input, "status");
      break;
    case "workflow":
      copyString(rawInput, input, "name");
      copyString(rawInput, input, "action");
      break;
    case "monitor":
      copyRawString(rawInput, input, "command");
      copyString(rawInput, input, "description");
      break;
  }
}

function buildBashResult(rawOutput: Record<string, unknown>) {
  return {
    stdout:
      decodeByteArray(rawOutput.output) ??
      rawStringField(rawOutput, "output_for_prompt") ??
      "",
    stderr: decodeByteArray(rawOutput.stderr) ?? "",
    interrupted:
      (rawOutput.signal !== null && rawOutput.signal !== undefined) ||
      rawOutput.timed_out === true,
    isImage: false,
    ...(numberField(rawOutput, "exit_code") !== undefined
      ? { exitCode: numberField(rawOutput, "exit_code") }
      : {}),
  };
}

function buildBackgroundCommandResult(rawOutput: Record<string, unknown>) {
  return {
    stdout: "",
    stderr: "",
    interrupted: false,
    isImage: false,
    backgroundTaskId: stringField(rawOutput, "task_id"),
  };
}

function buildReadResult(
  rawOutput: Record<string, unknown>,
  update: GrokToolUpdate,
  toolInput?: Record<string, unknown>,
) {
  const fileContent = asRecord(rawOutput.FileContent);
  const content =
    rawStringField(fileContent, "content") ??
    rawStringField(fileContent, "raw_output") ??
    "";
  const totalLines =
    numberField(fileContent, "total_lines") ??
    (content ? content.split("\n").length : 0);
  return {
    type: "text",
    file: {
      filePath: readFilePath(rawOutput, update, toolInput),
      content,
      numLines: totalLines,
      startLine: (numberField(asRecord(update.rawInput), "offset") ?? 0) + 1,
      totalLines,
    },
  };
}

function readFilePath(
  rawOutput: Record<string, unknown>,
  update: GrokToolUpdate,
  toolInput?: Record<string, unknown>,
): string {
  return (
    stringField(asRecord(rawOutput.FileContent), "absolute_path") ??
    firstLocationPath(update) ??
    firstString(asRecord(update.rawInput), [
      "target_file",
      "file_path",
      "path",
    ]) ??
    stringField(toolInput, "file_path") ??
    ""
  );
}

function buildGrepResult(
  rawOutput: Record<string, unknown>,
  toolInput?: Record<string, unknown>,
) {
  const stdout =
    decodeByteArray(rawOutput.stdout) ?? stringField(rawOutput, "stdout") ?? "";
  const mode = grepMode(stringField(toolInput, "output_mode"));
  const fileMatches = Array.isArray(rawOutput.file_matches)
    ? rawOutput.file_matches.flatMap((value) => {
        const record = asRecord(value);
        const path =
          typeof value === "string" ? value : stringField(record, "path");
        return path ? [{ path, record }] : [];
      })
    : [];
  const filenames =
    fileMatches.length > 0
      ? fileMatches.map(({ path }) => path)
      : grepFilenamesFromText(stdout);
  const result: Record<string, unknown> = {
    mode,
    filenames,
    numFiles: numberField(rawOutput, "match_count") ?? filenames.length,
  };
  const matches = fileMatches.flatMap(({ path, record }) =>
    Array.isArray(record?.matches)
      ? record.matches.flatMap((match) => {
          const item = asRecord(match);
          const lineNumber = numberField(item, "line_number");
          const text = rawStringField(item, "content");
          return lineNumber !== undefined && text
            ? [{ filePath: path, lineNumber, text }]
            : [];
        })
      : [],
  );
  if (matches.length > 0) result.matches = matches;
  if (mode === "content") {
    result.content = stripWorkspaceResultEnvelope(stdout);
    result.numLines = String(result.content).split("\n").filter(Boolean).length;
  }
  const appliedLimit = numberField(toolInput, "head_limit");
  if (appliedLimit !== undefined) result.appliedLimit = appliedLimit;
  return result;
}

function buildTodoResult(rawOutput: Record<string, unknown>) {
  return {
    oldTodos: [],
    newTodos: normalizeTodos(asRecord(rawOutput.TodosUpdated)?.todos),
  };
}

function buildWriteResult(
  rawOutput: Record<string, unknown>,
  update: GrokToolUpdate,
  toolInput: Record<string, unknown>,
) {
  const applied = asRecord(rawOutput.EditsApplied);
  const content =
    rawStringField(applied, "new_string") ??
    rawStringField(toolInput, "content") ??
    "";
  const filePath =
    stringField(applied, "absolute_path") ??
    stringField(toolInput, "file_path") ??
    firstLocationPath(update) ??
    "";
  const totalLines = content ? content.split("\n").length : 0;
  return {
    type: "text",
    file: {
      filePath,
      content,
      numLines: totalLines,
      startLine: 1,
      totalLines,
    },
  };
}

function buildEditResult(
  rawOutput: Record<string, unknown>,
  update: GrokToolUpdate,
  toolInput?: Record<string, unknown>,
) {
  const applied = asRecord(rawOutput.EditsApplied);
  const filePath =
    stringField(applied, "absolute_path") ??
    stringField(toolInput, "file_path") ??
    firstLocationPath(update) ??
    "";
  const oldString =
    rawStringField(applied, "old_string") ??
    rawStringField(toolInput, "old_string") ??
    "";
  const newString =
    rawStringField(applied, "new_string") ??
    rawStringField(toolInput, "new_string") ??
    "";
  return {
    filePath,
    oldString,
    newString,
    originalFile: "",
    replaceAll: toolInput?.replace_all === true,
    userModified: false,
    structuredPatch: structuredPatchFromUpdate(update, oldString, newString),
  };
}

function buildWebSearchResult(rawOutput: Record<string, unknown>) {
  const action = asRecord(rawOutput.action);
  const sources = Array.isArray(action?.sources)
    ? action.sources.flatMap((source) => {
        const url = stringField(asRecord(source), "url");
        return url ? [{ title: url, url }] : [];
      })
    : [];
  return {
    query: stringField(action, "query") ?? "",
    results: sources.length > 0 ? [{ content: sources }] : [],
    durationSeconds: 0,
  };
}

function buildWebFetchResult(
  rawOutput: Record<string, unknown>,
  toolInput?: Record<string, unknown>,
) {
  const content = asRecord(rawOutput.Content);
  const code = numberField(content, "status_code") ?? 0;
  return {
    bytes: numberField(content, "bytes") ?? 0,
    code,
    codeText: code === 200 ? "OK" : code ? `HTTP ${code}` : "",
    result: rawStringField(content, "content") ?? "",
    durationMs: 0,
    url: stringField(content, "url") ?? stringField(toolInput, "url") ?? "",
  };
}

function buildAskUserQuestionResult(
  rawOutput: Record<string, unknown>,
  toolInput?: Record<string, unknown>,
) {
  const message =
    stringField(asRecord(rawOutput.UserAnswered), "message") ?? "";
  return {
    questions: Array.isArray(toolInput?.questions) ? toolInput.questions : [],
    answers: answersFromMessage(message),
  };
}

function buildExitPlanModeResult(rawOutput: Record<string, unknown>) {
  const ready = asRecord(rawOutput.PlanReady);
  return {
    plan: rawStringField(ready, "plan_content") ?? "",
    isAgent: false,
    filePath: stringField(ready, "plan_file_path") ?? "",
  };
}

function buildImageResult(rawOutput: Record<string, unknown>) {
  const outputType = stringField(rawOutput, "type");
  const isVideo =
    outputType === "VideoGen" ||
    outputType === "ImageToVideo" ||
    outputType === "ReferenceToVideo";
  return {
    type: isVideo ? "video" : "image",
    path: stringField(rawOutput, "path") ?? "",
    filename: stringField(rawOutput, "filename") ?? "",
    sessionFolder: stringField(rawOutput, "session_folder") ?? "",
    ...(stringField(rawOutput, "uploaded_url")
      ? { uploadedUrl: stringField(rawOutput, "uploaded_url") }
      : {}),
  };
}

function buildTextToolResult(
  rawOutput: Record<string, unknown>,
  state?: NormalizedGrokToolState,
) {
  const text = stringField(rawOutput, "text") ?? "";
  if (state?.nativeName !== "spawn_subagent") return text;
  const agentId = /(?:subagent_id|agent_id):\s*([^\s]+)/.exec(text)?.[1];
  return {
    text,
    ...(agentId ? { agent_id: agentId } : {}),
  };
}

function isBackendWebSearchResult(rawOutput: Record<string, unknown>): boolean {
  return (
    rawOutput.type === undefined &&
    stringField(asRecord(rawOutput.action), "type") === "search"
  );
}

function taskOutputSummary(
  rawOutput: Record<string, unknown>,
): string | undefined {
  const multi = asRecord(rawOutput.MultiResult);
  if (multi) return stringField(multi, "summary");
  const single = asRecord(rawOutput.Result);
  return (
    stringField(single, "summary") ??
    stringField(single, "output") ??
    stringField(single, "status")
  );
}

function resultContentText(update: GrokToolUpdate): string | undefined {
  if (!Array.isArray(update.content)) return undefined;
  const parts = update.content.flatMap((value) => {
    const nested = asRecord(asRecord(value)?.content);
    const text = stringField(nested, "text");
    return text ? [text] : [];
  });
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function normalizeQuestions(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((question, index) => {
    const record = asRecord(question);
    const text = stringField(record, "question");
    if (!text) return [];
    const options = Array.isArray(record?.options)
      ? record.options.flatMap((option) => {
          const item = asRecord(option);
          const label = stringField(item, "label");
          if (!label) return [];
          return [
            {
              label,
              description: stringField(item, "description") ?? "",
              ...(stringField(item, "preview")
                ? { preview: stringField(item, "preview") }
                : {}),
            },
          ];
        })
      : [];
    return [
      {
        question: text,
        header:
          stringField(record, "header") ?? `Question ${String(index + 1)}`,
        options,
        multiSelect: record?.multiSelect === true,
      },
    ];
  });
}

function answersFromMessage(message: string): Record<string, string[]> {
  const answers: Record<string, string[]> = {};
  for (const match of message.matchAll(/"([^"]+)"="([^"]*)"/g)) {
    const question = match[1];
    const answer = match[2];
    if (question !== undefined && answer !== undefined) {
      answers[question] = [answer];
    }
  }
  return answers;
}

function normalizeTodos(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((todo) => {
    const record = asRecord(todo);
    const content = stringField(record, "content");
    const status = stringField(record, "status");
    if (!content || !status) return [];
    return [
      {
        ...record,
        content,
        status,
        activeForm: stringField(record, "activeForm") ?? content,
      },
    ];
  });
}

function structuredPatchFromUpdate(
  update: GrokToolUpdate,
  oldString: string,
  newString: string,
): Record<string, unknown>[] {
  if (Array.isArray(update.content)) {
    const hunks = update.content.flatMap((value) => {
      const diff = asRecord(value);
      if (diff?.type !== "diff") return [];
      const details = firstDiffDetail(diff);
      return [
        makePatchHunk(
          rawStringField(diff, "oldText") ?? oldString,
          rawStringField(diff, "newText") ?? newString,
          numberField(details, "old_line") ?? 1,
          numberField(details, "new_line") ?? 1,
        ),
      ];
    });
    if (hunks.length > 0) return hunks;
  }
  if (!oldString && !newString) return [];
  return [makePatchHunk(oldString, newString, 1, 1)];
}

function firstDiffDetail(
  diff: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const meta = asRecord(diff._meta);
  const details = Array.isArray(meta?.details)
    ? meta.details
    : meta && (meta.old_line !== undefined || meta.new_line !== undefined)
      ? [meta]
      : [];
  return asRecord(details[0]);
}

function makePatchHunk(
  oldText: string,
  newText: string,
  oldStart: number,
  newStart: number,
) {
  const oldLines = oldText ? oldText.split("\n") : [];
  const newLines = newText ? newText.split("\n") : [];
  return {
    oldStart,
    oldLines: oldLines.length,
    newStart,
    newLines: newLines.length,
    lines: [
      ...oldLines.map((line) => `-${line}`),
      ...newLines.map((line) => `+${line}`),
    ],
  };
}

function firstLocationPath(update: GrokToolUpdate): string | undefined {
  if (!Array.isArray(update.locations)) return undefined;
  return update.locations
    .map(asRecord)
    .map((location) => stringField(location, "path"))
    .find((path): path is string => path !== undefined);
}

function firstString(
  record: Record<string, unknown> | undefined,
  fields: string[],
): string | undefined {
  return fields
    .map((field) => stringField(record, field))
    .find((value): value is string => value !== undefined);
}

function copyString(
  from: Record<string, unknown> | undefined,
  to: Record<string, unknown>,
  field: string,
): void {
  const value = stringField(from, field);
  if (value !== undefined) to[field] = value;
}

function copyRawString(
  from: Record<string, unknown> | undefined,
  to: Record<string, unknown>,
  field: string,
): void {
  const value = rawStringField(from, field);
  if (value !== undefined) to[field] = value;
}

function copyNumber(
  from: Record<string, unknown> | undefined,
  to: Record<string, unknown>,
  field: string,
): void {
  const value = numberField(from, field);
  if (value !== undefined) to[field] = value;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringField(
  record: Record<string, unknown> | undefined,
  field: string,
): string | undefined {
  const value = record?.[field];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function rawStringField(
  record: Record<string, unknown> | undefined,
  field: string,
): string | undefined {
  const value = record?.[field];
  return typeof value === "string" ? value : undefined;
}

function numberField(
  record: Record<string, unknown> | undefined,
  field: string,
): number | undefined {
  const value = record?.[field];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is string =>
          typeof item === "string" && item.trim().length > 0,
      )
    : [];
}

function decodeByteArray(value: unknown): string | undefined {
  if (
    !Array.isArray(value) ||
    !value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
  ) {
    return undefined;
  }
  return new TextDecoder().decode(Uint8Array.from(value as number[]));
}

function grepMode(
  value: string | undefined,
): "files_with_matches" | "content" | "count" {
  return value === "content" || value === "count"
    ? value
    : "files_with_matches";
}

function grepFilenamesFromText(value: string): string[] {
  return stripWorkspaceResultEnvelope(value)
    .split("\n")
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.startsWith("/") ||
        line.startsWith(".") ||
        /^[A-Za-z]:[\\/]/.test(line),
    );
}

function stripWorkspaceResultEnvelope(value: string): string {
  return value
    .replace(/^<workspace_result[^>]*>\n?/, "")
    .replace(/\n?<\/workspace_result>$/, "")
    .replace(/^Found \d+ files\n?/, "");
}
