#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import type {
  SDKMessage,
  UserMessage,
} from "../packages/server/src/sdk/types.js";
import { ManagedCodexAuthOwner } from "../packages/server/src/sdk/providers/managed-codex-auth.js";
import {
  type ManagedSshCodexSessionResult,
  startManagedSshCodexSession,
} from "../packages/server/src/sdk/providers/managed-ssh-agent-session.js";
import { ManagedSshCodexDiagnosticProvider } from "../packages/server/src/sdk/providers/managed-ssh-diagnostic-provider.js";
import {
  ManagedSshTarget,
  readManagedRunnerManifest,
} from "../packages/server/src/sdk/providers/managed-ssh-target.js";
import {
  type ManagedSshWorkspace,
  ManagedSshWorkspaceService,
} from "../packages/server/src/sdk/providers/managed-ssh-workspace.js";
import { Supervisor } from "../packages/server/src/supervisor/Supervisor.js";

const hostAlias = requiredArgument("--host");
const remoteRoot = requiredArgument("--remote-root");
const artifactPath = resolve(requiredArgument("--artifact"));
const manifestPath = resolve(requiredArgument("--manifest"));
const nodeCommand = optionalArgument("--node") ?? "node";
const sshCommand = optionalArgument("--ssh") ?? "ssh";
const controllerCodexCommand =
  optionalArgument("--controller-codex-command") ?? "codex";
const controllerCodexArguments = parseStringArrayArgument(
  "--controller-codex-args-json",
);
const model = optionalArgument("--model") ?? "gpt-5.4-mini";
const cleanupTargetRoot = process.argv.includes("--cleanup-target-root");
const rootPackage = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { yepAnywhere?: { codexCli?: { expectedVersion?: unknown } } };
const expectedCodexVersion = requiredString(
  rootPackage.yepAnywhere?.codexCli?.expectedVersion,
  "package.json Codex expectedVersion",
);
const localFixture = await mkdtemp(
  join(tmpdir(), "ya-managed-gate-c-controller-"),
);
let fetchRepository: string | undefined;
let workspaceService: ManagedSshWorkspaceService | undefined;
let workspace: ManagedSshWorkspace | undefined;
let activeSession: ManagedSshCodexSessionResult | undefined;
let diagnosticSupervisor: Supervisor | undefined;
let diagnosticProcessId: string | undefined;

const target = new ManagedSshTarget({
  hostAlias,
  remoteRoot,
  nodeCommand,
  sshCommand,
  operationTimeoutMs: 30_000,
});

try {
  const manifest = await readManagedRunnerManifest(manifestPath);
  const inspection = await target.inspect();
  assertInspection(inspection, expectedCodexVersion);
  const install = await target.installRunnerArtifact(artifactPath, manifest, {
    inspection,
  });
  workspaceService = new ManagedSshWorkspaceService(target, inspection);

  const source = join(localFixture, "source");
  await mkdir(source);
  git(source, ["init", "--quiet", "--initial-branch=main"]);
  git(source, ["config", "user.email", "gate-c@example.invalid"]);
  git(source, ["config", "user.name", "Gate C Controller Fixture"]);
  await writeFile(join(source, "README.md"), "Gate C source fixture.\n");
  git(source, ["add", "README.md"]);
  git(source, ["commit", "--quiet", "-m", "gate c base"]);
  const sourceBefore = sourceFingerprint(source);

  workspace = await workspaceService.prepare(source);
  await workspaceService.runFixtureCommand(
    workspace,
    "git config user.email gate-c-target@example.invalid; git config user.name 'Gate C Target Fixture'",
  );

  const authOwner = new ManagedCodexAuthOwner({
    expectedCodexVersion,
    codexCommand: controllerCodexCommand,
    codexArguments: controllerCodexArguments,
    requestTimeoutMs: 10_000,
  });
  const approvals: string[] = [];
  const appliedModes: string[] = [];
  const yaSessionId = randomUUID();
  const commonOptions = {
    permissionMode: "default" as const,
    model,
    effort: "low" as const,
    clientName: "yep_anywhere_managed_gate_c",
    onToolApproval: async (toolName: string) => {
      approvals.push(toolName);
      return { behavior: "allow" as const };
    },
    onPermissionModeApplied: (mode: string) => appliedModes.push(mode),
  };

  activeSession = await startManagedSshCodexSession({
    targetId: "gate-c-linux-target",
    target,
    inspection,
    workspace,
    artifact: manifest,
    authOwner,
    expectedCodexVersion,
    options: commonOptions,
  });
  activeSession.session.activateCallbacks?.();
  const initial = await nextMessage(
    activeSession.session.iterator,
    "Codex init",
  );
  if (initial.type !== "system" || initial.subtype !== "init") {
    throw new Error("Gate C Codex session did not emit system/init first");
  }
  const providerSessionId = requiredString(
    initial.session_id,
    "target-native Codex thread id",
  );
  if (initial.cwd !== workspace.remoteWorktreePath) {
    throw new Error("Gate C Codex init did not report the managed target cwd");
  }
  if (activeSession.providerSessionId() !== providerSessionId) {
    throw new Error("Gate C provider identity did not bind behind the proxy");
  }
  await activeSession.session.publishAgentctlSessionId?.(yaSessionId);

  const discoveryEvents = await runTurn(activeSession, {
    text: [
      "Run pwd and git rev-parse --show-toplevel.",
      "Reply with GATE_C_CWD_OK only if both commands report the current managed workspace.",
      "Do not modify any files.",
    ].join(" "),
    uuid: randomUUID(),
  });
  assertAssistantMarker(discoveryEvents, "GATE_C_CWD_OK", "cwd turn");
  const configAck = discoveryEvents.find(
    (event) => event.type === "system" && event.subtype === "config_ack",
  );
  if (
    configAck?.configModel !== model ||
    configAck.configThinking !== "effort low" ||
    configAck.configMismatch === true
  ) {
    throw new Error(
      "Target Codex did not acknowledge the requested model/effort",
    );
  }

  const interruptedEvents: SDKMessage[] = [];
  activeSession.session.queue.push({
    text: "Run the shell command sleep 30, then reply GATE_C_SLEEP_FINISHED.",
    uuid: randomUUID(),
  });
  const interruptedTurn = collectUntilResult(
    activeSession.session.iterator,
    interruptedEvents,
    true,
  );
  await waitForProviderActive(activeSession, 20_000);
  await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  const interruptAccepted = await activeSession.session.interrupt?.();
  if (interruptAccepted !== true) {
    throw new Error("Gate C managed interrupt was not accepted");
  }
  await interruptedTurn;
  if (assistantText(interruptedEvents).includes("GATE_C_SLEEP_FINISHED")) {
    throw new Error("Gate C interrupted command unexpectedly completed");
  }

  const committedContent = "gate-c-managed-codex\n";
  const commitEvents = await runTurn(activeSession, {
    text: [
      "Create gate-c-result.txt with exactly one line: gate-c-managed-codex.",
      "Commit only that file with commit message 'gate c managed result'.",
      "You are in a read-only policy for this turn, so request the needed permission and perform the work after approval.",
      "Finish by replying GATE_C_COMMIT_OK only after git status --porcelain is empty.",
    ].join(" "),
    mode: "plan",
    uuid: randomUUID(),
  });
  assertAssistantMarker(commitEvents, "GATE_C_COMMIT_OK", "commit turn");
  if (approvals.length === 0) {
    throw new Error("Gate C commit turn did not exercise an approval callback");
  }
  const targetFile = await workspaceService.runFixtureCommand(
    workspace,
    "cat gate-c-result.txt",
  );
  if (targetFile !== committedContent) {
    throw new Error("Gate C target committed file content is incorrect");
  }
  const observation = await workspaceService.observe(workspace);
  if (
    observation.stagedCount !== 0 ||
    observation.unstagedCount !== 0 ||
    observation.untrackedCount !== 0 ||
    observation.head === workspace.baseCommit
  ) {
    throw new Error("Gate C target workspace did not reach a clean commit");
  }

  fetchRepository =
    await ManagedSshWorkspaceService.createDisposableFetchRepository();
  const fetch = await workspaceService.fetchIntoDisposableRepository(
    workspace,
    fetchRepository,
  );
  const fetchedContent = git(fetchRepository, [
    "show",
    `${fetch.destinationRef}:gate-c-result.txt`,
  ]);
  if (`${fetchedContent}\n` !== committedContent) {
    throw new Error("Gate C controller fetch did not recover committed bytes");
  }
  if (
    JSON.stringify(sourceFingerprint(source)) !== JSON.stringify(sourceBefore)
  ) {
    throw new Error("Gate C source checkout changed during managed execution");
  }

  await assertTargetSessionState(target, workspace, providerSessionId, true);
  let conflictFailure = "";
  try {
    const conflict = await startManagedSshCodexSession({
      targetId: "gate-c-linux-target",
      target,
      inspection,
      workspace,
      artifact: manifest,
      authOwner,
      expectedCodexVersion,
      options: { ...commonOptions, resumeSessionId: providerSessionId },
    });
    await conflict.session.abort();
    throw new Error("Gate C conflicting runner unexpectedly started");
  } catch (error) {
    conflictFailure = errorMessage(error);
    if (!conflictFailure.includes("already has an active runner")) {
      throw error;
    }
  }

  await activeSession.session.abort();
  const firstDiagnostics = activeSession.diagnostics();
  activeSession = undefined;
  await assertTargetProcessesStopped(target, workspace);

  const resumedApprovals: string[] = [];
  activeSession = await startManagedSshCodexSession({
    targetId: "gate-c-linux-target",
    target,
    inspection,
    workspace,
    artifact: manifest,
    authOwner,
    expectedCodexVersion,
    options: {
      ...commonOptions,
      resumeSessionId: providerSessionId,
      onToolApproval: async (toolName) => {
        resumedApprovals.push(toolName);
        return { behavior: "allow" };
      },
    },
  });
  activeSession.session.activateCallbacks?.();
  const resumedInit = await nextMessage(
    activeSession.session.iterator,
    "resumed Codex init",
  );
  if (
    resumedInit.type !== "system" ||
    resumedInit.subtype !== "init" ||
    resumedInit.session_id !== providerSessionId ||
    activeSession.providerSessionId() !== providerSessionId ||
    activeSession.execution.workspaceId !== workspace.workspaceId
  ) {
    throw new Error("Gate C resume changed provider or workspace identity");
  }
  await activeSession.session.publishAgentctlSessionId?.(yaSessionId);
  const resumeEvents = await runTurn(activeSession, {
    text: "Do not use tools. Reply exactly GATE_C_RESUME_OK.",
    uuid: randomUUID(),
  });
  assertAssistantMarker(resumeEvents, "GATE_C_RESUME_OK", "resume turn");
  await assertTargetSessionState(target, workspace, providerSessionId, true);
  await activeSession.session.abort();
  const resumedDiagnostics = activeSession.diagnostics();
  activeSession = undefined;
  await assertTargetProcessesStopped(target, workspace);

  const diagnosticProvider = new ManagedSshCodexDiagnosticProvider({
    targetId: "gate-c-linux-target",
    target,
    inspection,
    workspace,
    artifact: manifest,
    authOwner,
    expectedCodexVersion,
    modelId: model,
  });
  diagnosticSupervisor = new Supervisor({
    provider: diagnosticProvider,
    idleTimeoutMs: -1,
  });
  const diagnosticProcess = await diagnosticSupervisor.reactivateSession(
    workspace.remoteWorktreePath,
    providerSessionId,
    "default",
    {
      providerName: "codex",
      model,
      requestedModel: model,
      effort: "low",
      recapMode: "off",
      promptSuggestionMode: "off",
    },
  );
  diagnosticProcessId = diagnosticProcess.id;
  if (
    diagnosticProcess.execution.kind !== "managed-ssh" ||
    diagnosticProcess.execution.targetId !== "gate-c-linux-target" ||
    diagnosticProcess.execution.workspaceId !== workspace.workspaceId ||
    diagnosticProcess.executor !== undefined
  ) {
    throw new Error(
      "Gate C Supervisor/Process lost or overloaded the managed execution coordinate",
    );
  }
  const supervisorEvents = diagnosticProcess.getMessageHistory();
  const unsubscribeDiagnostic = diagnosticProcess.subscribe((event) => {
    if (event.type === "message") supervisorEvents.push(event.message);
    if (event.type === "state-change" && event.state.type === "waiting-input") {
      diagnosticProcess.respondToInput(event.state.request.id, "approve");
    }
  });
  const queued = diagnosticProcess.queueMessage({
    text: "Do not use tools. Reply exactly GATE_C_PROCESS_OK.",
    uuid: randomUUID(),
  });
  if (!queued.success) {
    throw new Error(`Gate C Process queue failed: ${queued.error}`);
  }
  await waitForCondition(
    () =>
      assistantText(supervisorEvents).includes("GATE_C_PROCESS_OK") &&
      diagnosticProcess.state.type === "idle" &&
      diagnosticProcess.queueDepth === 0,
    120_000,
    "Supervisor/Process turn",
  );
  unsubscribeDiagnostic();
  const diagnosticAbort =
    await diagnosticSupervisor.abortProcessWithVerification(
      diagnosticProcess.id,
    );
  diagnosticProcessId = undefined;
  if (!diagnosticAbort?.verifiedStopped) {
    throw new Error("Gate C Supervisor did not verify managed shutdown");
  }
  const diagnosticSession = diagnosticProvider.latestSession();
  if (
    !diagnosticSession ||
    diagnosticSession.providerSessionId() !== providerSessionId ||
    diagnosticSession.diagnostics().terminal?.classification !== "clean"
  ) {
    throw new Error(
      "Gate C Supervisor/Process provider identity or shutdown diagnostics changed",
    );
  }
  await assertTargetProcessesStopped(target, workspace);

  const cleanup = await workspaceService.cleanup(workspace);
  workspace = undefined;
  if (cleanup.disposition !== "deleted") {
    throw new Error(`Gate C clean workspace was retained: ${cleanup.reason}`);
  }
  if (cleanupTargetRoot) {
    assertDisposableTargetRoot(remoteRoot);
    await target.runCommand(
      `set -eu; test ! -e '${remoteRoot}/workspaces' || test -z "$(find '${remoteRoot}/workspaces' -mindepth 1 -maxdepth 1 -print -quit)"; rm -rf -- '${remoteRoot}'; test ! -e '${remoteRoot}'`,
    );
  }

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      controller: { platform: process.platform, architecture: process.arch },
      target: {
        platform: inspection.platform,
        architecture: inspection.architecture,
        nodeVersion: inspection.node.version,
        gitVersion: inspection.git.version,
        codexVersion: inspection.codex.version,
        localCodexLoginRequired: false,
        authFileWritten: false,
      },
      artifact: {
        cacheHit: install.cacheHit,
        byteSize: install.byteSize,
        sha256: install.sha256,
      },
      identity: {
        yaSessionStable: true,
        providerThreadStable: true,
        workspaceStable: true,
        supervisorProcessExecution: "managed-ssh",
      },
      controls: {
        approvalCount: approvals.length,
        approvalTools: [...new Set(approvals)],
        interruptAccepted,
        appliedModes: [...new Set(appliedModes)],
      },
      stream: {
        discoveryEventTypes: eventTypeCounts(discoveryEvents),
        interruptedEventTypes: eventTypeCounts(interruptedEvents),
        commitEventTypes: eventTypeCounts(commitEvents),
        resumeEventTypes: eventTypeCounts(resumeEvents),
        supervisorEventTypes: eventTypeCounts(supervisorEvents),
        retainedControllerProjectionEvents:
          discoveryEvents.length +
          interruptedEvents.length +
          commitEvents.length,
        coldHistoricalProjection: "target-native-rollout-only",
      },
      sourceReturn: {
        baseCommit: workspace?.baseCommit ?? sourceBefore.head,
        fetchedHead: fetch.fetchedHead,
        baseIsAncestor: fetch.baseIsAncestor,
        targetAdvancedDuringFetch: fetch.targetAdvancedDuringFetch,
        sourceCheckoutUnchanged: true,
      },
      failures: {
        conflictingWriter: conflictFailure,
      },
      cleanup: {
        firstRunner: firstDiagnostics.terminal?.classification,
        resumedRunner: resumedDiagnostics.terminal?.classification,
        supervisorRunner:
          diagnosticSession.diagnostics().terminal?.classification,
        targetProcesses: "stopped",
        workspace: cleanup.disposition,
        targetRoot: cleanupTargetRoot ? "deleted" : "retained-cache-only",
      },
      resumedApprovalCount: resumedApprovals.length,
    })}\n`,
  );
} catch (error) {
  if (diagnosticSupervisor && diagnosticProcessId) {
    await diagnosticSupervisor
      .abortProcessWithVerification(diagnosticProcessId)
      .catch(() => {});
  }
  if (activeSession) await activeSession.session.abort().catch(() => {});
  if (workspace && workspaceService) {
    await workspaceService
      .cleanup(workspace, { explicitDiscard: true })
      .catch(() => {});
  }
  throw error;
} finally {
  await rm(localFixture, { recursive: true, force: true });
  if (fetchRepository) {
    await rm(fetchRepository, { recursive: true, force: true });
  }
}

async function runTurn(
  managed: ManagedSshCodexSessionResult,
  message: UserMessage,
): Promise<SDKMessage[]> {
  managed.session.queue.push(message);
  const events: SDKMessage[] = [];
  await collectUntilResult(managed.session.iterator, events, false);
  return events;
}

async function collectUntilResult(
  iterator: AsyncIterableIterator<SDKMessage>,
  events: SDKMessage[],
  allowErrors: boolean,
): Promise<void> {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const next = await nextMessage(
      iterator,
      "Codex turn",
      deadline - Date.now(),
    );
    events.push(next);
    if (next.type === "error" && !allowErrors) {
      throw new Error(`Gate C Codex turn failed: ${errorMessage(next.error)}`);
    }
    if (next.type === "result") return;
  }
  throw new Error("Gate C Codex turn timed out");
}

async function nextMessage(
  iterator: AsyncIterableIterator<SDKMessage>,
  label: string,
  timeoutMs = 30_000,
): Promise<SDKMessage> {
  const result = await Promise.race([
    iterator.next(),
    new Promise<never>((_, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`${label} timed out`)),
        Math.max(1, timeoutMs),
      );
      timeout.unref?.();
    }),
  ]);
  if (result.done || !result.value) {
    throw new Error(`${label} ended before its expected event`);
  }
  return result.value;
}

function assistantText(events: SDKMessage[]): string {
  return events
    .filter((event) => event.type === "assistant")
    .flatMap((event) => {
      const content = event.message?.content;
      if (typeof content === "string") return [content];
      if (!Array.isArray(content)) return [];
      return content.flatMap((block) => {
        if (!block || typeof block !== "object") return [];
        const value = block as { type?: unknown; text?: unknown };
        return value.type === "text" && typeof value.text === "string"
          ? [value.text]
          : [];
      });
    })
    .join("\n");
}

function assertAssistantMarker(
  events: SDKMessage[],
  marker: string,
  label: string,
): void {
  const text = assistantText(events);
  if (!text.includes(marker)) {
    throw new Error(
      `Gate C ${label} did not emit ${marker}; assistant=${JSON.stringify(text.slice(0, 500))} events=${JSON.stringify(eventTypeCounts(events))}`,
    );
  }
}

async function assertTargetSessionState(
  target: ManagedSshTarget,
  workspace: ManagedSshWorkspace,
  providerSessionId: string,
  expectActiveLease: boolean,
): Promise<void> {
  if (!/^[A-Za-z0-9-]{8,128}$/.test(providerSessionId)) {
    throw new Error("Gate C target-native thread id is unsafe to inspect");
  }
  const activeLeaseCheck = expectActiveLease
    ? `test -d '${workspace.remoteDirectory}/active-runner-lease'`
    : `test ! -e '${workspace.remoteDirectory}/active-runner-lease'`;
  await target.runCommand(
    [
      "set -eu",
      `test ! -e '${workspace.remoteDirectory}/codex-home/auth.json'`,
      activeLeaseCheck,
      `test "$(find '${workspace.remoteDirectory}/codex-home/sessions' -type f -name '*${providerSessionId}*.jsonl' 2>/dev/null | wc -l)" -ge 1`,
    ].join("; "),
  );
}

async function assertTargetProcessesStopped(
  target: ManagedSshTarget,
  workspace: ManagedSshWorkspace,
): Promise<void> {
  const command = [
    "set -eu",
    `test ! -e '${workspace.remoteDirectory}/active-runner-lease'`,
    `test ! -e '${workspace.remoteDirectory}/codex-home/auth.json'`,
    'test -z "$(pgrep -u "$(id -u)" -x codex || true)"',
    'test -z "$(pgrep -u "$(id -u)" -x node || true)"',
  ].join("; ");
  const deadline = Date.now() + 10_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await target.runCommand(command);
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
  }
  throw new Error(
    `Gate C target processes did not stop: ${errorMessage(lastError)}`,
  );
}

function eventTypeCounts(events: SDKMessage[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const event of events) {
    const key = event.subtype ? `${event.type}/${event.subtype}` : event.type;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function assertInspection(
  inspection: Awaited<ReturnType<ManagedSshTarget["inspect"]>>,
  expectedVersion: string,
): void {
  if (inspection.platform !== "Linux") {
    throw new Error(`Gate C requires Linux, observed ${inspection.platform}`);
  }
  if (!inspection.node.compatible || !inspection.git.available) {
    throw new Error("Gate C target requires compatible Node.js and Git");
  }
  if (inspection.codex.version !== `codex-cli ${expectedVersion}`) {
    throw new Error(
      `Gate C target Codex is incompatible: ${inspection.codex.version ?? "unavailable"}`,
    );
  }
}

function sourceFingerprint(cwd: string): Record<string, string> {
  return {
    head: git(cwd, ["rev-parse", "HEAD"]),
    branch: git(cwd, ["symbolic-ref", "HEAD"]),
    status: git(cwd, ["status", "--porcelain=v1", "--untracked-files=all"]),
    diff: git(cwd, ["diff", "--binary"]),
    cachedDiff: git(cwd, ["diff", "--cached", "--binary"]),
  };
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  }).trim();
}

async function waitForProviderActive(
  managed: ManagedSshCodexSessionResult,
  timeoutMs: number,
): Promise<void> {
  if (!managed.session.probeLiveness) {
    throw new Error("Gate C managed session has no liveness probe");
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const probe = await managed.session.probeLiveness();
    if (probe.status === "active" || probe.status === "waiting-input") return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("Gate C provider did not become active before interrupt");
}

function assertDisposableTargetRoot(value: string): void {
  if (
    !value.startsWith("/tmp/ya-managed-gate-c-") ||
    basename(value).length <= "ya-managed-gate-c-".length
  ) {
    throw new Error(
      "--cleanup-target-root requires /tmp/ya-managed-gate-c-<unique>",
    );
  }
}

function requiredArgument(name: string): string {
  const value = optionalArgument(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function optionalArgument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function parseStringArrayArgument(name: string): string[] {
  const value = optionalArgument(name);
  if (!value) return [];
  const parsed: unknown = JSON.parse(value);
  if (
    !Array.isArray(parsed) ||
    parsed.some((item) => typeof item !== "string")
  ) {
    throw new Error(`${name} must be a JSON string array`);
  }
  return parsed;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) {
    throw new Error(`Missing ${label}`);
  }
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error(`Gate C ${label} timed out`);
}
