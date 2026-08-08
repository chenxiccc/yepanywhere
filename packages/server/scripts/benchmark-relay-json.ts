import { performance } from "node:perf_hooks";
import { BinaryFormat } from "@yep-anywhere/shared";
import {
  decompressGzip,
  decryptBinaryEnvelopeRaw,
} from "../src/crypto/index.js";
import {
  createConnectionState,
  createSendFn,
  type WSAdapter,
} from "../src/routes/ws-relay-handlers.js";
import {
  readHostCapacity,
  readHostSample,
  summarizeHostWindow,
} from "../../../scripts/perf-suite/host-profile.mjs";

const SAMPLES = 7;
const WARMUPS = 2;
const MESSAGE_COUNT = 1_000;
const TEXT_BYTES = 4 * 1024;
const SESSION_KEY = new Uint8Array(32).fill(17);

type Mode = "plaintext" | "encrypted";
type Arm = "parsed-reencode" | "validated-raw";

interface Capture {
  lastFrame: string | ArrayBuffer | Uint8Array<ArrayBuffer> | null;
  observedBytes: number;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function fixtureText(index: number): string {
  const prefix = `message-${index.toString().padStart(4, "0")}:`;
  return `${prefix}${"abcdefghijklmnopqrstuvwxyz012345".repeat(
    Math.ceil((TEXT_BYTES - prefix.length) / 32),
  )}`.slice(0, TEXT_BYTES);
}

const bodyText = JSON.stringify({
  messages: Array.from({ length: MESSAGE_COUNT }, (_, index) => ({
    id: `message-${index}`,
    role: index % 2 === 0 ? "assistant" : "user",
    text: fixtureText(index),
  })),
});
const bodyBytes = new TextEncoder().encode(bodyText);

function createArm(mode: Mode, arm: Arm) {
  const capture: Capture = { lastFrame: null, observedBytes: 0 };
  const ws: WSAdapter = {
    send(frame) {
      capture.lastFrame = frame;
      capture.observedBytes +=
        typeof frame === "string" ? Buffer.byteLength(frame) : frame.byteLength;
    },
    close(code, reason) {
      throw new Error(`Synthetic socket closed: ${code} ${reason}`);
    },
  };
  const state = createConnectionState();
  state.authState = "authenticated";
  if (mode === "plaintext") {
    state.connectionPolicy = "local_unrestricted";
  } else {
    state.sessionKey = SESSION_KEY;
    state.supportedFormats = new Set([
      BinaryFormat.JSON,
      BinaryFormat.COMPRESSED_JSON,
    ]);
  }
  const send = createSendFn(ws, state);

  const operation = () => {
    const parsed = JSON.parse(bodyText) as { messages?: unknown[] };
    if (parsed.messages?.length !== MESSAGE_COUNT) {
      throw new Error("Synthetic JSON validation changed the fixture");
    }
    if (arm === "parsed-reencode") {
      send({
        type: "response",
        id: "benchmark-response",
        status: 200,
        headers: { "server-timing": "route;dur=1" },
        body: parsed,
      });
      return;
    }
    send.sendValidatedJsonResponse?.({
      type: "response",
      id: "benchmark-response",
      status: 200,
      headers: { "server-timing": "route;dur=1" },
      bodyBytes,
      bodyText,
    });
  };

  return { capture, operation };
}

function decodedFrame(mode: Mode, capture: Capture): unknown {
  const frame = capture.lastFrame;
  if (frame === null) throw new Error("Synthetic sender produced no frame");
  if (mode === "plaintext") {
    if (typeof frame !== "string") {
      throw new Error("Plaintext benchmark unexpectedly produced binary");
    }
    return JSON.parse(frame);
  }
  if (typeof frame === "string") {
    throw new Error("Encrypted benchmark unexpectedly produced text");
  }
  const decrypted = decryptBinaryEnvelopeRaw(frame, SESSION_KEY);
  if (!decrypted) throw new Error("Synthetic encrypted frame did not decrypt");
  const json =
    decrypted.format === BinaryFormat.COMPRESSED_JSON
      ? decompressGzip(decrypted.payload)
      : new TextDecoder().decode(decrypted.payload);
  return JSON.parse(json);
}

function verify(mode: Mode, capture: Capture): void {
  const decoded = decodedFrame(mode, capture) as {
    msg?: { body?: { messages?: Array<{ text?: string }> } };
    body?: { messages?: Array<{ text?: string }> };
  };
  const messages = decoded.msg?.body?.messages ?? decoded.body?.messages;
  if (
    messages?.length !== MESSAGE_COUNT ||
    messages[0]?.text !== fixtureText(0) ||
    messages.at(-1)?.text !== fixtureText(MESSAGE_COUNT - 1)
  ) {
    throw new Error(`Synthetic ${mode} response changed its JSON body`);
  }
}

const capacity = await readHostCapacity();
const hostStart = await readHostSample(capacity);
const results: Record<Mode, Record<Arm, number[]>> = {
  plaintext: { "parsed-reencode": [], "validated-raw": [] },
  encrypted: { "parsed-reencode": [], "validated-raw": [] },
};

for (const mode of ["plaintext", "encrypted"] as const) {
  const baseline = createArm(mode, "parsed-reencode");
  const candidate = createArm(mode, "validated-raw");
  for (let index = 0; index < WARMUPS; index += 1) {
    baseline.operation();
    candidate.operation();
  }
  for (let sample = 0; sample < SAMPLES; sample += 1) {
    const arms =
      sample % 2 === 0
        ? ([baseline, candidate] as const)
        : ([candidate, baseline] as const);
    for (const measured of arms) {
      const startedAt = performance.now();
      measured.operation();
      const durationMs = performance.now() - startedAt;
      const name = measured === baseline ? "parsed-reencode" : "validated-raw";
      results[mode][name].push(durationMs);
    }
  }
  verify(mode, baseline.capture);
  verify(mode, candidate.capture);
}

const hostEnd = await readHostSample(capacity);
console.log(
  `RELAY_JSON_HOST: ${JSON.stringify({
    capacityKey: capacity.capacityKey,
    start: hostStart,
    end: hostEnd,
    window: summarizeHostWindow(capacity, hostStart, hostEnd),
  })}`,
);
for (const mode of ["plaintext", "encrypted"] as const) {
  const baselineMs = median(results[mode]["parsed-reencode"]);
  const candidateMs = median(results[mode]["validated-raw"]);
  console.log(
    [
      "RELAY_JSON_BENCHMARK:",
      `mode=${mode}`,
      `body_bytes=${bodyBytes.byteLength}`,
      `samples=${SAMPLES}`,
      `parsed_reencode_median_ms=${baselineMs.toFixed(2)}`,
      `validated_raw_median_ms=${candidateMs.toFixed(2)}`,
      `speedup=${(baselineMs / candidateMs).toFixed(2)}x`,
    ].join(" "),
  );
}
