import {
  ALL_PERMISSION_MODES,
  type PermissionMode,
} from "@yep-anywhere/shared";
import { type Context, Hono } from "hono";
import { stream } from "hono/streaming";
import {
  getProviderHostInventory,
  getProviderHostSessionTurnStatus,
  getProviderHostStatus,
  interruptProviderHostSessionTurn,
  isProviderRuntimeHostAvailable,
  type ProviderHostSessionTurnRecord,
  type ProviderHostSessionTurnRequest,
  streamProviderHostSessionTurn,
} from "../sdk/providers/provider-runtime-host.js";
import {
  PROVIDER_SESSION_OPTION_KEYS,
  resolveProviderSessionOptions,
  type ProviderSessionOptions,
} from "../sdk/providers/types.js";

const MAX_SESSION_TURN_BODY_BYTES = 1024 * 1024;
const MAX_SESSION_TURN_TEXT_BYTES = 900 * 1024;
const MIN_SESSION_TURN_TIMEOUT_MS = 1_000;
const MAX_SESSION_TURN_TIMEOUT_MS = 2 * 60 * 60_000;

export interface ProviderHostRoutesDeps {
  available: () => boolean;
  status: () => Promise<Record<string, unknown>>;
  inventory: () => Promise<unknown[]>;
  streamTurn: (
    request: ProviderHostSessionTurnRequest,
    signal?: AbortSignal,
  ) => AsyncIterable<ProviderHostSessionTurnRecord>;
  turnStatus: (submissionId: string) => Promise<Record<string, unknown> | null>;
  interruptTurn: (submissionId: string) => Promise<Record<string, unknown>>;
}

const defaultDeps: ProviderHostRoutesDeps = {
  available: isProviderRuntimeHostAvailable,
  status: getProviderHostStatus,
  inventory: getProviderHostInventory,
  streamTurn: streamProviderHostSessionTurn,
  turnStatus: getProviderHostSessionTurnStatus,
  interruptTurn: interruptProviderHostSessionTurn,
};

function unavailable(c: Context) {
  return c.json(
    { error: "Provider host control is unavailable", outcome: "unavailable" },
    503,
  );
}

async function readTurnRequest(
  request: Request,
): Promise<ProviderHostSessionTurnRequest> {
  const chunks: Uint8Array[] = [];
  let bodyBytes = 0;
  if (request.body) {
    const reader = request.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bodyBytes += value.byteLength;
      if (bodyBytes > MAX_SESSION_TURN_BODY_BYTES) {
        await reader.cancel();
        throw new Error("Session-turn request exceeds 1 MiB");
      }
      chunks.push(value);
    }
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("Invalid session-turn JSON");
  }
  if (!value || typeof value !== "object") {
    throw new Error("Invalid session-turn request");
  }
  const body = value as Record<string, unknown>;
  const target = body.target as Record<string, unknown> | undefined;
  const message = body.message as Record<string, unknown> | undefined;
  const submissionId =
    typeof body.submissionId === "string" ? body.submissionId.trim() : "";
  const harness =
    typeof target?.harness === "string" ? target.harness.trim() : "";
  const providerSessionId =
    typeof target?.providerSessionId === "string"
      ? target.providerSessionId.trim()
      : "";
  const text = typeof message?.text === "string" ? message.text : "";
  const rawSessionOptions = body.sessionOptions;
  if (!submissionId || submissionId.length > 200) {
    throw new Error(
      "submissionId is required and must be at most 200 characters",
    );
  }
  if (!harness || !providerSessionId) {
    throw new Error("target.harness and target.providerSessionId are required");
  }
  if (!text.trim() || Buffer.byteLength(text) > MAX_SESSION_TURN_TEXT_BYTES) {
    throw new Error("message.text is required and must be at most 900 KiB");
  }
  if (
    rawSessionOptions !== undefined &&
    (!rawSessionOptions ||
      typeof rawSessionOptions !== "object" ||
      Array.isArray(rawSessionOptions))
  ) {
    throw new Error("sessionOptions must be an object");
  }
  const sessionOptions = (rawSessionOptions ?? {}) as Record<string, unknown>;
  for (const [key, option] of Object.entries(sessionOptions)) {
    if (
      !PROVIDER_SESSION_OPTION_KEYS.includes(
        key as (typeof PROVIDER_SESSION_OPTION_KEYS)[number],
      )
    ) {
      throw new Error(`Unknown provider session option ${key}`);
    }
    if (typeof option !== "boolean") {
      throw new Error(`Provider session option ${key} must be boolean`);
    }
  }
  if ("launch" in body) {
    throw new Error("The HTTP adapter cannot launch provider runtimes");
  }
  const mode = message?.mode;
  if (
    mode !== undefined &&
    !ALL_PERMISSION_MODES.includes(mode as PermissionMode)
  ) {
    throw new Error("message.mode is invalid");
  }
  const timeoutMs = Number(body.timeoutMs);
  if (
    body.timeoutMs !== undefined &&
    (!Number.isFinite(timeoutMs) ||
      timeoutMs < MIN_SESSION_TURN_TIMEOUT_MS ||
      timeoutMs > MAX_SESSION_TURN_TIMEOUT_MS)
  ) {
    throw new Error("timeoutMs must be between 1000 and 7200000");
  }
  return {
    submissionId,
    target: {
      harness,
      providerSessionId,
      ...(typeof target?.yaSessionId === "string" && target.yaSessionId.trim()
        ? { yaSessionId: target.yaSessionId.trim() }
        : {}),
    },
    message: {
      text,
      ...(mode ? { mode: mode as PermissionMode } : {}),
    },
    sessionOptions: resolveProviderSessionOptions(
      sessionOptions as ProviderSessionOptions,
    ),
    ...(Number.isFinite(timeoutMs) ? { timeoutMs } : {}),
  };
}

export function createProviderHostRoutes(
  deps: ProviderHostRoutesDeps = defaultDeps,
): Hono {
  const routes = new Hono();

  routes.get("/status", async (c) => {
    if (!deps.available()) return unavailable(c);
    try {
      return c.json({ available: true, ...(await deps.status()) });
    } catch {
      return unavailable(c);
    }
  });

  routes.get("/runtimes", async (c) => {
    if (!deps.available()) return unavailable(c);
    try {
      return c.json({ runtimes: await deps.inventory() });
    } catch {
      return unavailable(c);
    }
  });

  routes.post("/session-turn", async (c) => {
    if (!deps.available()) return unavailable(c);
    let request: ProviderHostSessionTurnRequest;
    try {
      request = await readTurnRequest(c.req.raw);
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : String(error) },
        400,
      );
    }
    c.header("Content-Type", "application/x-ndjson");
    c.header("Cache-Control", "no-store");
    return stream(c, async (body) => {
      let accepted = false;
      try {
        for await (const record of deps.streamTurn(request, c.req.raw.signal)) {
          if (record.type === "accepted") accepted = true;
          await body.write(`${JSON.stringify(record)}\n`);
        }
      } catch (error) {
        if (c.req.raw.signal.aborted) return;
        await body.write(
          `${JSON.stringify({
            type: "error",
            submissionId: request.submissionId,
            outcome: accepted ? "uncertain-after-acceptance" : "unavailable",
            accepted,
            error: error instanceof Error ? error.message : String(error),
          })}\n`,
        );
      }
    });
  });

  routes.get("/session-turn/:submissionId", async (c) => {
    if (!deps.available()) return unavailable(c);
    try {
      const status = await deps.turnStatus(c.req.param("submissionId"));
      return status
        ? c.json(status)
        : c.json({ error: "Session-turn receipt not found" }, 404);
    } catch {
      return unavailable(c);
    }
  });

  routes.post("/session-turn/:submissionId/interrupt", async (c) => {
    if (!deps.available()) return unavailable(c);
    try {
      return c.json(await deps.interruptTurn(c.req.param("submissionId")));
    } catch {
      return unavailable(c);
    }
  });

  return routes;
}
