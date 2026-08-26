#!/usr/bin/env node
/**
 * Real Codex app-server external-subscription-auth probe.
 *
 * The probe reads a controller-owned Codex auth cache, but sends only its
 * current access token and account projection to an app-server running with an
 * isolated CODEX_HOME. It never sends the refresh token. The optional refresh
 * exercise deliberately corrupts the access-token signature, waits for
 * app-server's account/chatgptAuthTokens/refresh request, and responds with the
 * valid access token so the original request can retry.
 *
 * Usage:
 *   node scripts/probe-codex-external-auth.mjs
 *   # This option intentionally rotates the controller's stored OAuth tokens.
 *   CODEX_PROBE_MANAGED_REFRESH=true \
 *     node scripts/probe-codex-external-auth.mjs
 *   CODEX_PROBE_COMMAND=pnpm \
 *     CODEX_PROBE_ARGS_JSON='["--silent","dlx","@openai/codex@0.149.0"]' \
 *     node scripts/probe-codex-external-auth.mjs
 */

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

const COMMAND = process.env.CODEX_PROBE_COMMAND || "codex";
const COMMAND_ARGS = parseCommandArgs(
  process.env.CODEX_PROBE_ARGS_JSON || "[]",
);
const AUTH_FILE =
  process.env.CODEX_PROBE_AUTH_FILE || join(homedir(), ".codex", "auth.json");
const AUTH_PROJECTION_FILE = process.env.CODEX_PROBE_AUTH_PROJECTION_FILE;
const REQUEST_TIMEOUT_MS = Number(process.env.CODEX_PROBE_TIMEOUT_MS || 30_000);
const RUN_REFRESH_PROBE = process.env.CODEX_PROBE_REFRESH !== "false";
const RUN_MANAGED_REFRESH = process.env.CODEX_PROBE_MANAGED_REFRESH === "true";
const REQUESTED_MODEL = process.env.CODEX_PROBE_MODEL || "gpt-5.4-mini";

if (RUN_MANAGED_REFRESH && AUTH_PROJECTION_FILE) {
  throw new Error(
    "CODEX_PROBE_MANAGED_REFRESH requires the controller auth cache, not an access-only projection",
  );
}

const sourceAuth = JSON.parse(
  readFileSync(AUTH_PROJECTION_FILE || AUTH_FILE, "utf8"),
);
const initialAccessToken = requiredString(
  AUTH_PROJECTION_FILE
    ? sourceAuth.accessToken
    : sourceAuth.tokens?.access_token,
  AUTH_PROJECTION_FILE ? "accessToken" : "tokens.access_token",
);
const refreshToken = AUTH_PROJECTION_FILE
  ? null
  : requiredString(sourceAuth.tokens?.refresh_token, "tokens.refresh_token");
let currentAccessToken = initialAccessToken;
const secretsToRedact = new Set([initialAccessToken]);
if (refreshToken) secretsToRedact.add(refreshToken);

const accessClaims = decodeJwtClaims(initialAccessToken);
const openAiClaims = accessClaims["https://api.openai.com/auth"];
const chatgptAccountId = requiredString(
  (AUTH_PROJECTION_FILE
    ? sourceAuth.chatgptAccountId
    : sourceAuth.tokens?.account_id) ?? openAiClaims?.chatgpt_account_id,
  "ChatGPT account id",
);
const chatgptPlanType =
  typeof sourceAuth.chatgptPlanType === "string"
    ? sourceAuth.chatgptPlanType
    : typeof openAiClaims?.chatgpt_plan_type === "string"
      ? openAiClaims.chatgpt_plan_type
      : null;

const codexHome = mkdtempSync(join(tmpdir(), "ya-codex-external-auth-"));
const cwd = mkdtempSync(join(tmpdir(), "ya-codex-external-auth-workspace-"));
writeFileSync(
  join(cwd, "README.md"),
  "Temporary Codex external-auth probe workspace. Do not modify.\n",
  "utf8",
);

let nextId = 1;
let stdoutBuffer = "";
let stderrBuffer = "";
let refreshRequests = 0;
let refreshTokenForwarded = false;
let acceptRefreshRequests = false;
const pending = new Map();
const notifications = [];
let managedOwner = null;

const childEnv = { ...process.env, CODEX_HOME: codexHome };
delete childEnv.OPENAI_API_KEY;
delete childEnv.CODEX_API_KEY;
delete childEnv.CODEX_ACCESS_TOKEN;

const child = spawn(
  COMMAND,
  [...COMMAND_ARGS, "app-server", "--listen", "stdio://"],
  {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: childEnv,
    shell: false,
  },
);

function parseCommandArgs(value) {
  const parsed = JSON.parse(value);
  if (
    !Array.isArray(parsed) ||
    parsed.some((item) => typeof item !== "string")
  ) {
    throw new Error("CODEX_PROBE_ARGS_JSON must be a JSON string array");
  }
  return parsed;
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing ${label}`);
  }
  return value;
}

function decodeJwtClaims(token) {
  const payload = token.split(".")[1];
  if (!payload) throw new Error("Access token is not a JWT");
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
}

function corruptJwtSignature(token) {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[2].length === 0) {
    throw new Error("Access token is not a signed JWT");
  }
  const first = parts[2][0];
  parts[2] = `${first === "A" ? "B" : "A"}${parts[2].slice(1)}`;
  return parts.join(".");
}

function redact(value) {
  let redacted = String(value);
  for (const secret of secretsToRedact) {
    redacted = redacted.replaceAll(secret, "[credential-redacted]");
  }
  return redacted;
}

function log(event, value) {
  console.log(`${event}: ${JSON.stringify(value)}`);
}

function sendRaw(payload) {
  const serialized = JSON.stringify(payload);
  if (refreshToken && serialized.includes(refreshToken)) {
    refreshTokenForwarded = true;
    throw new Error("Refusing to forward the controller refresh token");
  }
  child.stdin.write(`${serialized}\n`);
}

function request(method, params, timeoutMs = REQUEST_TIMEOUT_MS) {
  const id = nextId++;
  const promise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out waiting for ${method}`));
    }, timeoutMs);
    pending.set(id, {
      resolve: (result) => {
        clearTimeout(timeout);
        resolve(result);
      },
      reject: (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    });
  });
  sendRaw({ jsonrpc: "2.0", id, method, params });
  return promise;
}

function notify(method, params) {
  sendRaw(
    params === undefined
      ? { jsonrpc: "2.0", method }
      : { jsonrpc: "2.0", method, params },
  );
}

function respond(id, result) {
  sendRaw({ jsonrpc: "2.0", id, result });
}

function rejectRequest(id, message) {
  sendRaw({
    jsonrpc: "2.0",
    id,
    error: { code: -32_001, message },
  });
}

function handleLine(line) {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }

  if (message.method && message.id !== undefined) {
    if (message.method === "account/chatgptAuthTokens/refresh") {
      refreshRequests += 1;
      if (!acceptRefreshRequests) {
        rejectRequest(message.id, "Unexpected refresh request");
        return;
      }
      void refreshProjection()
        .then((projection) => respond(message.id, projection))
        .catch((error) => {
          rejectRequest(
            message.id,
            redact(error instanceof Error ? error.message : error),
          );
        });
      return;
    }
    rejectRequest(
      message.id,
      `Unsupported probe server request ${message.method}`,
    );
    return;
  }

  if (message.id !== undefined) {
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) {
      waiter.reject(new Error(message.error.message || "JSON-RPC error"));
    } else {
      waiter.resolve(message.result);
    }
    return;
  }

  if (message.method) {
    notifications.push(message);
  }
}

function startJsonRpcChild(codexHomeDirectory) {
  const rpcChild = spawn(
    COMMAND,
    [...COMMAND_ARGS, "app-server", "--listen", "stdio://"],
    {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, CODEX_HOME: codexHomeDirectory },
      shell: false,
    },
  );
  let nextRequestId = 1;
  let buffer = "";
  let stderr = "";
  const requestWaiters = new Map();

  const send = (payload) => {
    rpcChild.stdin.write(`${JSON.stringify(payload)}\n`);
  };
  const rpcRequest = (method, params) => {
    const id = nextRequestId++;
    const promise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        requestWaiters.delete(id);
        reject(new Error(`Timed out waiting for controller ${method}`));
      }, REQUEST_TIMEOUT_MS);
      requestWaiters.set(id, {
        resolve: (result) => {
          clearTimeout(timeout);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
    });
    send({ jsonrpc: "2.0", id, method, params });
    return promise;
  };

  rpcChild.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.id === undefined || message.method) continue;
      const waiter = requestWaiters.get(message.id);
      if (!waiter) continue;
      requestWaiters.delete(message.id);
      if (message.error) {
        waiter.reject(
          new Error(message.error.message || "Controller JSON-RPC error"),
        );
      } else {
        waiter.resolve(message.result);
      }
    }
  });
  rpcChild.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  rpcChild.on("exit", (code, signal) => {
    for (const [id, waiter] of requestWaiters) {
      requestWaiters.delete(id);
      waiter.reject(
        new Error(
          `Controller Codex exited code=${code} signal=${signal}: ${redact(stderr.slice(-2_000))}`,
        ),
      );
    }
  });

  return {
    notify(method, params) {
      send(
        params === undefined
          ? { jsonrpc: "2.0", method }
          : { jsonrpc: "2.0", method, params },
      );
    },
    request: rpcRequest,
    async stop() {
      if (rpcChild.exitCode !== null || rpcChild.signalCode !== null) return;
      rpcChild.stdin.end();
      rpcChild.kill("SIGTERM");
      await Promise.race([
        new Promise((resolve) => rpcChild.once("exit", resolve)),
        new Promise((resolve) => setTimeout(resolve, 2_000)),
      ]);
      if (rpcChild.exitCode === null && rpcChild.signalCode === null) {
        rpcChild.kill("SIGKILL");
      }
    },
  };
}

async function startManagedAuthOwner() {
  const owner = startJsonRpcChild(dirname(AUTH_FILE));
  await owner.request("initialize", {
    clientInfo: {
      name: "ya_codex_managed_auth_owner_probe",
      title: null,
      version: "dev",
    },
    capabilities: {},
  });
  owner.notify("initialized");
  return owner;
}

async function refreshProjection() {
  if (RUN_MANAGED_REFRESH) {
    await managedOwner.request("account/read", { refreshToken: true });
    const refreshedAuth = JSON.parse(readFileSync(AUTH_FILE, "utf8"));
    const refreshedAccessToken = requiredString(
      refreshedAuth.tokens?.access_token,
      "refreshed tokens.access_token",
    );
    const refreshedClaims = decodeJwtClaims(refreshedAccessToken);
    const refreshedOpenAiClaims =
      refreshedClaims["https://api.openai.com/auth"];
    const refreshedAccountId = requiredString(
      refreshedAuth.tokens?.account_id ??
        refreshedOpenAiClaims?.chatgpt_account_id,
      "refreshed ChatGPT account id",
    );
    if (refreshedAccountId !== chatgptAccountId) {
      throw new Error("Controller account changed during managed refresh");
    }
    currentAccessToken = refreshedAccessToken;
    secretsToRedact.add(refreshedAccessToken);
  }

  return {
    accessToken: currentAccessToken,
    chatgptAccountId,
    chatgptPlanType,
  };
}

child.stdout.on("data", (chunk) => {
  stdoutBuffer += chunk.toString("utf8");
  const lines = stdoutBuffer.split("\n");
  stdoutBuffer = lines.pop() || "";
  for (const line of lines) handleLine(line);
});

child.stderr.on("data", (chunk) => {
  stderrBuffer += chunk.toString("utf8");
});

child.on("exit", (code, signal) => {
  for (const [id, waiter] of pending) {
    pending.delete(id);
    waiter.reject(new Error(`Codex exited code=${code} signal=${signal}`));
  }
});

async function loginWithExternalToken(token) {
  return request("account/login/start", {
    type: "chatgptAuthTokens",
    accessToken: token,
    chatgptAccountId,
    chatgptPlanType,
  });
}

function waitForNotification(predicate, timeoutMs = REQUEST_TIMEOUT_MS) {
  const existing = notifications.find(predicate);
  if (existing) return Promise.resolve(existing);

  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const interval = setInterval(() => {
      const notification = notifications.find(predicate);
      if (notification) {
        clearInterval(interval);
        resolve(notification);
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        clearInterval(interval);
        reject(new Error("Timed out waiting for matching notification"));
      }
    }, 25);
  });
}

function selectModel(modelList) {
  const ids = Array.isArray(modelList?.data)
    ? modelList.data
        .map((entry) => entry?.id)
        .filter((id) => typeof id === "string")
    : [];
  return (
    ids.find((id) => id === REQUESTED_MODEL) ??
    ids.find((id) => /mini|spark|fast|small/i.test(id)) ??
    ids[0]
  );
}

function summarizeRateLimits(result) {
  return {
    present: result !== null && typeof result === "object",
    keys:
      result !== null && typeof result === "object"
        ? Object.keys(result).sort()
        : [],
  };
}

async function stopChild() {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.stdin.end();
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
  }
}

try {
  if (RUN_MANAGED_REFRESH) {
    managedOwner = await startManagedAuthOwner();
  }

  const initialize = await request("initialize", {
    clientInfo: {
      name: "ya_codex_external_auth_probe",
      title: null,
      version: "dev",
    },
    capabilities: { experimentalApi: true },
  });
  notify("initialized");
  log("initialize", {
    userAgentPresent: typeof initialize?.userAgent === "string",
  });

  const login = await loginWithExternalToken(initialAccessToken);
  log("external-login", { type: login?.type, planType: chatgptPlanType });

  const account = await request("account/read", { refreshToken: false });
  log("account-read", {
    accountPresent: account?.account !== null,
    accountType: account?.account?.type,
    planType: account?.account?.planType,
    requiresOpenaiAuth: account?.requiresOpenaiAuth,
  });

  const initialRateLimits = await request("account/rateLimits/read");
  log("rate-limits", summarizeRateLimits(initialRateLimits));

  if (RUN_REFRESH_PROBE) {
    const modelList = await request("model/list", {});
    const model = selectModel(modelList);
    if (!model) throw new Error("model/list returned no usable model");

    await loginWithExternalToken(corruptJwtSignature(initialAccessToken));
    const threadStart = await request("thread/start", {
      cwd,
      model,
      config: { model_reasoning_effort: "low" },
      approvalPolicy: "never",
      sandbox: "read-only",
      experimentalRawEvents: false,
      persistExtendedHistory: false,
    });
    const threadId = threadStart?.thread?.id;
    if (!threadId) throw new Error("thread/start did not return thread.id");

    acceptRefreshRequests = true;
    const turnStart = await request("turn/start", {
      threadId,
      model,
      effort: "low",
      summary: "auto",
      input: [
        {
          type: "text",
          text: "Do not use tools. Reply with exactly: AUTH REFRESH OK",
          text_elements: [],
        },
      ],
    });
    const turnId = turnStart?.turn?.id;
    if (!turnId) throw new Error("turn/start did not return turn.id");
    const completed = await waitForNotification(
      (message) =>
        message.method === "turn/completed" &&
        message.params?.turn?.id === turnId,
      REQUEST_TIMEOUT_MS * 2,
    );
    acceptRefreshRequests = false;
    log("refresh-retry", {
      refreshRequests,
      model,
      turnStatus: completed.params?.turn?.status,
      succeeded:
        refreshRequests === 1 && completed.params?.turn?.status === "completed",
    });
  }

  log("credential-boundary", {
    sourceRefreshTokenLoaded: refreshToken !== null,
    refreshTokenForwarded,
    managedControllerRefresh: RUN_MANAGED_REFRESH,
    accessTokenRotated: currentAccessToken !== initialAccessToken,
    isolatedAuthFileCreated: existsSync(join(codexHome, "auth.json")),
  });
} catch (error) {
  log("probe-error", {
    message: redact(error instanceof Error ? error.message : error),
    stderr: redact(stderrBuffer.slice(-2_000)),
  });
  process.exitCode = 1;
} finally {
  if (managedOwner) await managedOwner.stop();
  await stopChild();
  rmSync(codexHome, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
}
