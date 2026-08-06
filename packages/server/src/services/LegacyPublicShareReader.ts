import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import {
  PUBLIC_SHARE_SESSION_DECOMPRESSED_MAX_BYTES,
  type UrlProjectId,
} from "@yep-anywhere/shared";
import type { PublicShareRecord } from "./PublicShareService.js";
import { enforceOwnerOnlyPathPermissionsStrict } from "../utils/filePermissions.js";

export interface LegacySessionBody {
  filePath: string | null;
  snapshotBytes: number;
  oversized: boolean;
}

export interface LegacyViewerSnapshot {
  capturedAt: string;
  body: LegacySessionBody;
}

export interface LegacyPublicShareRecord
  extends Omit<
    PublicShareRecord,
    | "version"
    | "shareId"
    | "shareStateId"
    | "initialPrompt"
    | "revisionId"
    | "linkedFileMode"
    | "snapshotBytes"
    | "viewerSnapshots"
  > {
  version: 1;
  frozenSession?: LegacySessionBody;
  viewerSnapshots?: Record<string, LegacyViewerSnapshot>;
}

async function* decodeUtf8Chunks(
  source: AsyncIterable<string | Buffer>,
): AsyncGenerator<string> {
  let decoder = new StringDecoder("utf8");
  for await (const chunk of source) {
    if (typeof chunk === "string") {
      const pending = decoder.end();
      if (pending) yield pending;
      decoder = new StringDecoder("utf8");
      yield chunk;
      continue;
    }
    const decoded = decoder.write(chunk);
    if (decoded) yield decoded;
  }
  const trailing = decoder.end();
  if (trailing) yield trailing;
}

class StreamingCharacterReader {
  private readonly iterator: AsyncIterator<string>;
  private chunk = "";
  private index = 0;
  private pushed: string | null = null;

  constructor(source: string | AsyncIterable<string | Buffer>) {
    const input =
      typeof source === "string"
        ? createReadStream(source, {
            encoding: "utf8",
            highWaterMark: 64 * 1024,
          })
        : source;
    this.iterator = decodeUtf8Chunks(input)[Symbol.asyncIterator]();
  }

  async next(): Promise<string | null> {
    if (this.pushed !== null) {
      const value = this.pushed;
      this.pushed = null;
      return value;
    }
    while (this.index >= this.chunk.length) {
      const next = await this.iterator.next();
      if (next.done) return null;
      this.chunk = String(next.value);
      this.index = 0;
    }
    return this.chunk[this.index++] ?? null;
  }

  push(character: string): void {
    if (this.pushed !== null) {
      throw new Error("Legacy JSON parser pushback overflow");
    }
    this.pushed = character;
  }

  async close(): Promise<void> {
    await this.iterator.return?.();
  }
}

async function nextNonWhitespace(
  reader: StreamingCharacterReader,
): Promise<string | null> {
  while (true) {
    const character = await reader.next();
    if (character === null || !/\s/.test(character)) return character;
  }
}

async function expectCharacter(
  reader: StreamingCharacterReader,
  expected: string,
): Promise<void> {
  const actual = await nextNonWhitespace(reader);
  if (actual !== expected) {
    throw new Error(
      `Invalid legacy public share JSON: expected ${expected}, received ${actual ?? "EOF"}`,
    );
  }
}

async function readJsonString(
  reader: StreamingCharacterReader,
  openingQuoteConsumed = false,
): Promise<string> {
  if (!openingQuoteConsumed) await expectCharacter(reader, '"');
  let raw = '"';
  let escaped = false;
  while (true) {
    const character = await reader.next();
    if (character === null) {
      throw new Error("Invalid legacy public share JSON: unterminated string");
    }
    raw += character;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === '"') return JSON.parse(raw) as string;
  }
}

type JsonChunkConsumer = (chunk: string) => Promise<void> | void;

async function copyJsonValue(
  reader: StreamingCharacterReader,
  consume: JsonChunkConsumer,
): Promise<void> {
  let output = "";
  const flush = async () => {
    if (!output) return;
    const chunk = output;
    output = "";
    await consume(chunk);
  };
  const emit = async (value: string) => {
    output += value;
    if (output.length >= 64 * 1024) await flush();
  };
  const parseString = async () => {
    await emit('"');
    while (true) {
      const character = await reader.next();
      if (character === null || character.charCodeAt(0) <= 0x1f) {
        throw new Error("Invalid legacy public share JSON string");
      }
      await emit(character);
      if (character === '"') return;
      if (character !== "\\") continue;
      const escaped = await reader.next();
      if (escaped === null || !/["\\/bfnrtu]/.test(escaped)) {
        throw new Error("Invalid legacy public share JSON string escape");
      }
      await emit(escaped);
      if (escaped !== "u") continue;
      for (let index = 0; index < 4; index += 1) {
        const digit = await reader.next();
        if (digit === null || !/[0-9A-Fa-f]/.test(digit)) {
          throw new Error("Invalid legacy public share JSON unicode escape");
        }
        await emit(digit);
      }
    }
  };
  const parsePrimitive = async (first: string) => {
    if (first === "t" || first === "f" || first === "n") {
      const literal = first === "t" ? "true" : first === "f" ? "false" : "null";
      await emit(first);
      for (const expected of literal.slice(1)) {
        const actual = await reader.next();
        if (actual !== expected) {
          throw new Error("Invalid legacy public share JSON literal");
        }
        await emit(actual);
      }
      return;
    }
    let token = first;
    while (true) {
      const character = await reader.next();
      if (character === null) break;
      if (/\s/.test(character)) break;
      if (character === "," || character === "]" || character === "}") {
        reader.push(character);
        break;
      }
      token += character;
    }
    if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(token)) {
      throw new Error("Invalid legacy public share JSON number");
    }
    await emit(token);
  };
  const parseValue = async (first?: string): Promise<void> => {
    const opening = first ?? (await nextNonWhitespace(reader));
    if (opening === null) {
      throw new Error("Invalid legacy public share JSON: missing value");
    }
    if (opening === '"') {
      await parseString();
      return;
    }
    if (opening === "{") {
      await emit(opening);
      let next = await nextNonWhitespace(reader);
      if (next === "}") {
        await emit(next);
        return;
      }
      if (next !== '"') {
        throw new Error("Invalid legacy public share JSON object key");
      }
      while (true) {
        await parseString();
        if ((await nextNonWhitespace(reader)) !== ":") {
          throw new Error("Invalid legacy public share JSON object separator");
        }
        await emit(":");
        await parseValue();
        next = await nextNonWhitespace(reader);
        if (next === "}") {
          await emit(next);
          break;
        }
        if (next !== ",") {
          throw new Error("Invalid legacy public share JSON object separator");
        }
        await emit(next);
        next = await nextNonWhitespace(reader);
        if (next !== '"') {
          throw new Error("Invalid legacy public share JSON object key");
        }
      }
      return;
    }
    if (opening === "[") {
      await emit(opening);
      let next = await nextNonWhitespace(reader);
      if (next === "]") {
        await emit(next);
        return;
      }
      if (next === null) {
        throw new Error("Invalid legacy public share JSON array");
      }
      while (true) {
        await parseValue(next);
        next = await nextNonWhitespace(reader);
        if (next === "]") {
          await emit(next);
          break;
        }
        if (next !== ",") {
          throw new Error("Invalid legacy public share JSON array separator");
        }
        await emit(next);
        next = await nextNonWhitespace(reader);
        if (next === null) {
          throw new Error("Invalid legacy public share JSON array");
        }
      }
      return;
    }
    await parsePrimitive(opening);
  };

  await parseValue();
  await flush();
}

async function collectJsonValue(
  reader: StreamingCharacterReader,
): Promise<unknown> {
  let raw = "";
  await copyJsonValue(reader, (chunk) => {
    raw += chunk;
  });
  return JSON.parse(raw);
}

async function countJsonArrayEntries(
  reader: StreamingCharacterReader,
): Promise<number | null> {
  const opening = await nextNonWhitespace(reader);
  if (opening === null) {
    throw new Error("Invalid legacy public share JSON: missing array");
  }
  if (opening !== "[") {
    reader.push(opening);
    await copyJsonValue(reader, () => undefined);
    return null;
  }

  let count = 0;
  let next = await nextNonWhitespace(reader);
  if (next === "]") return count;
  if (next === null) {
    throw new Error("Invalid legacy public share JSON: truncated array");
  }
  while (true) {
    reader.push(next);
    await copyJsonValue(reader, () => undefined);
    count += 1;
    const separator = await nextNonWhitespace(reader);
    if (separator === "]") return count;
    if (separator !== ",") {
      throw new Error("Invalid legacy public share JSON array separator");
    }
    next = await nextNonWhitespace(reader);
    if (next === null) {
      throw new Error("Invalid legacy public share JSON: truncated array");
    }
  }
}

async function writeBodyValue(
  reader: StreamingCharacterReader,
  temporaryDirectory: string,
  sequence: number,
  maxSnapshotBytes: number,
): Promise<LegacySessionBody> {
  const filePath = path.join(temporaryDirectory, `body-${sequence}.json`);
  const handle = await fs.open(filePath, "wx", 0o600);
  let inString = false;
  let escaped = false;
  let snapshotBytes = 0;
  let oversized = false;
  try {
    await enforceOwnerOnlyPathPermissionsStrict(filePath, "file");
    await copyJsonValue(reader, async (chunk) => {
      let canonical = "";
      for (const character of chunk) {
        if (inString) {
          canonical += character;
          if (escaped) escaped = false;
          else if (character === "\\") escaped = true;
          else if (character === '"') inString = false;
          continue;
        }
        if (character === '"') {
          inString = true;
          canonical += character;
        } else if (!/\s/.test(character)) {
          canonical += character;
        }
      }
      const chunkBytes = Buffer.byteLength(canonical, "utf8");
      snapshotBytes += chunkBytes;
      if (snapshotBytes > maxSnapshotBytes) {
        oversized = true;
      }
      if (canonical && !oversized) {
        await handle.write(canonical, undefined, "utf8");
      }
    });
    if (!oversized) await handle.sync();
  } finally {
    await handle.close();
  }
  if (oversized) await fs.rm(filePath);
  return {
    filePath: oversized ? null : filePath,
    snapshotBytes,
    oversized,
  };
}

function normalizeLegacyMentionedPath(
  rawCandidate: string,
  projectRoot: string,
): string | null {
  let candidate = rawCandidate
    .replace(/^[[(`'"<]+/, "")
    .replace(/[\])},.;!?`'">]+$/, "");
  try {
    candidate = decodeURIComponent(candidate);
  } catch {
    return null;
  }
  candidate = candidate.replace(/:\d+(?::\d+)?$/, "");
  if (
    !candidate ||
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(candidate) ||
    /^[a-z][a-z0-9+.-]*:/i.test(candidate)
  ) {
    return null;
  }

  const absolute = path.isAbsolute(candidate)
    ? path.resolve(candidate)
    : path.resolve(projectRoot, candidate);
  const relative = path.relative(path.resolve(projectRoot), absolute);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }
  return relative.split(path.sep).join("/");
}

function collectLegacyPathCandidates(
  value: string,
  projectRoot: string,
  projectId: UrlProjectId,
  authorizedPaths: Set<string>,
): void {
  if (!value.includes(".")) return;
  for (const match of value.matchAll(
    /(?:https?:\/\/[^\s"'<>)]*)?\/(?:api\/local-(?:file|image)|projects\/[^/\s"'<>]+\/file)\?[^\s"'<>)]*/g,
  )) {
    try {
      const url = new URL(match[0] ?? "", "http://share.local");
      const projectMatch = /^\/projects\/([^/]+)\/file$/.exec(url.pathname);
      if (
        projectMatch?.[1] &&
        decodeURIComponent(projectMatch[1]) !== projectId
      ) {
        continue;
      }
      const normalized = normalizeLegacyMentionedPath(
        url.searchParams.get("path") ?? "",
        projectRoot,
      );
      if (normalized) authorizedPaths.add(normalized);
    } catch {
      // A malformed URL-looking token grants nothing.
    }
  }

  for (const match of value.matchAll(
    /(?:[A-Za-z]:[\\/]|\/)?[A-Za-z0-9_.@%+~:\\/-]*[A-Za-z0-9_.@%+~-]+\.[A-Za-z0-9]{1,16}(?::\d+(?::\d+)?)?/g,
  )) {
    const normalized = normalizeLegacyMentionedPath(
      match[0] ?? "",
      projectRoot,
    );
    if (normalized) authorizedPaths.add(normalized);
  }
}

/**
 * Recover the frozen file-capability manifest without materializing the body.
 * String values are decoded one token at a time; oversized non-path text is
 * discarded at a fixed bound.
 */
export async function collectLegacyAuthorizedPaths(
  filePath: string,
  projectRoot: string,
  projectId: UrlProjectId,
): Promise<string[]> {
  const authorizedPaths = new Set<string>();
  let inString = false;
  let escaped = false;
  let unicodeDigits = "";
  let token = "";
  let tokenOverflowed = false;
  const flush = () => {
    if (token && !tokenOverflowed) {
      collectLegacyPathCandidates(
        token,
        projectRoot,
        projectId,
        authorizedPaths,
      );
    }
    token = "";
    tokenOverflowed = false;
  };
  const append = (character: string) => {
    if (/\s/.test(character)) {
      flush();
      return;
    }
    if (!tokenOverflowed && token.length < 16 * 1024) {
      token += character;
    } else {
      token = "";
      tokenOverflowed = true;
    }
  };

  for await (const chunk of createReadStream(filePath, {
    encoding: "utf8",
    highWaterMark: 64 * 1024,
  })) {
    for (const character of chunk) {
      if (!inString) {
        if (character === '"') inString = true;
        continue;
      }
      if (unicodeDigits) {
        unicodeDigits += character;
        if (unicodeDigits.length === 5) {
          const codePoint = Number.parseInt(unicodeDigits.slice(1), 16);
          if (!Number.isNaN(codePoint)) append(String.fromCharCode(codePoint));
          unicodeDigits = "";
          escaped = false;
        }
        continue;
      }
      if (escaped) {
        if (character === "u") unicodeDigits = "u";
        else {
          const decoded =
            ({ b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" } as const)[
              character as "b" | "f" | "n" | "r" | "t"
            ] ?? character;
          append(decoded);
          escaped = false;
        }
        continue;
      }
      if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        flush();
        inString = false;
      } else {
        append(character);
      }
    }
  }
  flush();
  return [...authorizedPaths].sort();
}

async function parseViewerSnapshots(
  reader: StreamingCharacterReader,
  temporaryDirectory: string,
  nextBodySequence: () => number,
  maxSnapshotBytes: number,
): Promise<Record<string, LegacyViewerSnapshot> | undefined> {
  const first = await nextNonWhitespace(reader);
  if (first === "n") {
    reader.push(first);
    await collectJsonValue(reader);
    return undefined;
  }
  if (first !== "{") {
    throw new Error("Invalid legacy viewerSnapshots object");
  }
  const snapshots = Object.create(null) as Record<string, LegacyViewerSnapshot>;
  let separator = await nextNonWhitespace(reader);
  if (separator === "}") return undefined;
  if (separator === null) throw new Error("Truncated legacy viewerSnapshots");
  reader.push(separator);
  while (true) {
    const viewerId = await readJsonString(reader);
    await expectCharacter(reader, ":");
    await expectCharacter(reader, "{");
    let capturedAt: string | undefined;
    let body: LegacySessionBody | undefined;
    let fieldSeparator = await nextNonWhitespace(reader);
    if (fieldSeparator !== "}") {
      if (fieldSeparator === null) throw new Error("Truncated viewer snapshot");
      reader.push(fieldSeparator);
      while (true) {
        const key = await readJsonString(reader);
        await expectCharacter(reader, ":");
        if (key === "capturedAt") {
          const value = await collectJsonValue(reader);
          if (typeof value === "string") capturedAt = value;
        } else if (key === "frozenSession") {
          body = await writeBodyValue(
            reader,
            temporaryDirectory,
            nextBodySequence(),
            maxSnapshotBytes,
          );
        } else {
          await copyJsonValue(reader, () => undefined);
        }
        fieldSeparator = await nextNonWhitespace(reader);
        if (fieldSeparator === "}") break;
        if (fieldSeparator !== ",") {
          throw new Error("Invalid legacy viewer snapshot field separator");
        }
      }
    }
    if (!capturedAt || !body) {
      throw new Error("Legacy viewer snapshot is missing capturedAt or body");
    }
    snapshots[viewerId] = { capturedAt, body };
    separator = await nextNonWhitespace(reader);
    if (separator === "}") break;
    if (separator !== ",") {
      throw new Error("Invalid legacy viewerSnapshots separator");
    }
  }
  return Object.keys(snapshots).length > 0 ? snapshots : undefined;
}

async function parseRecord(
  reader: StreamingCharacterReader,
  temporaryDirectory: string,
  nextBodySequence: () => number,
  maxSnapshotBytes: number,
): Promise<LegacyPublicShareRecord> {
  await expectCharacter(reader, "{");
  const compact: Record<string, unknown> = {};
  let frozenSession: LegacySessionBody | undefined;
  let viewerSnapshots: Record<string, LegacyViewerSnapshot> | undefined;
  let separator = await nextNonWhitespace(reader);
  if (separator === "}") {
    throw new Error("Legacy public share record is empty");
  }
  if (separator === null) throw new Error("Truncated legacy share record");
  reader.push(separator);
  while (true) {
    const key = await readJsonString(reader);
    await expectCharacter(reader, ":");
    if (key === "frozenSession") {
      frozenSession = await writeBodyValue(
        reader,
        temporaryDirectory,
        nextBodySequence(),
        maxSnapshotBytes,
      );
    } else if (key === "viewerSnapshots") {
      viewerSnapshots = await parseViewerSnapshots(
        reader,
        temporaryDirectory,
        nextBodySequence,
        maxSnapshotBytes,
      );
    } else {
      compact[key] = await collectJsonValue(reader);
    }
    separator = await nextNonWhitespace(reader);
    if (separator === "}") break;
    if (separator !== ",") {
      throw new Error("Invalid legacy public share record separator");
    }
  }
  const record = compact as unknown as LegacyPublicShareRecord;
  if (
    record.version !== 1 ||
    typeof record.secretHash !== "string" ||
    (record.mode !== "live" && record.mode !== "frozen") ||
    typeof record.createdAt !== "string" ||
    typeof record.updatedAt !== "string" ||
    !record.source ||
    typeof record.source.projectId !== "string" ||
    typeof record.source.sessionId !== "string" ||
    (record.mode === "frozen" && !frozenSession)
  ) {
    throw new Error("Invalid legacy public share record metadata");
  }
  return { ...record, frozenSession, viewerSnapshots };
}

export async function* readLegacyPublicShareRecords(
  filePath: string,
  temporaryDirectory: string,
  maxSnapshotBytes = PUBLIC_SHARE_SESSION_DECOMPRESSED_MAX_BYTES,
): AsyncGenerator<LegacyPublicShareRecord> {
  await fs.mkdir(temporaryDirectory, { recursive: true, mode: 0o700 });
  await enforceOwnerOnlyPathPermissionsStrict(temporaryDirectory, "directory");
  const reader = new StreamingCharacterReader(filePath);
  let bodySequence = 0;
  const nextBodySequence = () => {
    bodySequence += 1;
    return bodySequence;
  };
  try {
    await expectCharacter(reader, "{");
    let separator = await nextNonWhitespace(reader);
    if (separator === "}") {
      throw new Error("Legacy public share store has no shares array");
    }
    if (separator === null) throw new Error("Truncated legacy share store");
    reader.push(separator);
    let foundShares = false;
    while (true) {
      const key = await readJsonString(reader);
      await expectCharacter(reader, ":");
      if (key !== "shares") {
        await copyJsonValue(reader, () => undefined);
      } else {
        foundShares = true;
        await expectCharacter(reader, "[");
        let itemSeparator = await nextNonWhitespace(reader);
        if (itemSeparator !== "]") {
          if (itemSeparator === null) throw new Error("Truncated shares array");
          reader.push(itemSeparator);
          while (true) {
            yield await parseRecord(
              reader,
              temporaryDirectory,
              nextBodySequence,
              maxSnapshotBytes,
            );
            itemSeparator = await nextNonWhitespace(reader);
            if (itemSeparator === "]") break;
            if (itemSeparator !== ",") {
              throw new Error("Invalid legacy shares array separator");
            }
          }
        }
      }
      separator = await nextNonWhitespace(reader);
      if (separator === "}") break;
      if (separator !== ",") {
        throw new Error("Invalid legacy share store separator");
      }
    }
    if (!foundShares) {
      throw new Error("Legacy public share store has no shares array");
    }
    if ((await nextNonWhitespace(reader)) !== null) {
      throw new Error("Legacy public share store has trailing content");
    }
  } finally {
    await reader.close();
  }
}

export async function inspectLegacySessionBody(
  source: string | AsyncIterable<string | Buffer>,
): Promise<{ repairRequired: boolean }> {
  const reader = new StreamingCharacterReader(source);
  let messageCount = 0;
  let actualMessageCount: number | null | undefined;
  try {
    await expectCharacter(reader, "{");
    let separator = await nextNonWhitespace(reader);
    if (separator === "}") return { repairRequired: false };
    if (separator === null) throw new Error("Truncated legacy session body");
    reader.push(separator);
    while (true) {
      const key = await readJsonString(reader);
      await expectCharacter(reader, ":");
      if (key === "messageCount") {
        const value = await collectJsonValue(reader);
        if (typeof value === "number" && Number.isFinite(value)) {
          messageCount = value;
        }
      } else if (key === "messages") {
        actualMessageCount = await countJsonArrayEntries(reader);
      } else {
        await copyJsonValue(reader, () => undefined);
      }
      separator = await nextNonWhitespace(reader);
      if (separator === "}") break;
      if (separator !== ",") {
        throw new Error("Invalid legacy session body separator");
      }
    }
    return {
      repairRequired:
        actualMessageCount === undefined
          ? messageCount > 0
          : actualMessageCount === null || actualMessageCount < messageCount,
    };
  } finally {
    await reader.close();
  }
}
