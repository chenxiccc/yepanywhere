import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { UrlProjectId } from "@yep-anywhere/shared";
import type { PublicShareRecord } from "./PublicShareService.js";

export interface LegacySessionBody {
  filePath: string;
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

class StreamingCharacterReader {
  private readonly iterator: AsyncIterator<string | Buffer>;
  private chunk = "";
  private index = 0;
  private pushed: string | null = null;

  constructor(filePath: string) {
    this.iterator = createReadStream(filePath, {
      encoding: "utf8",
      highWaterMark: 64 * 1024,
    })[Symbol.asyncIterator]();
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

  async copyValueFromFirst(
    first: string,
    consume: JsonChunkConsumer,
  ): Promise<void> {
    let output = first;
    const flush = async () => {
      if (!output) return;
      const value = output;
      output = "";
      await consume(value);
    };
    const refill = async (): Promise<boolean> => {
      await flush();
      const next = await this.iterator.next();
      if (next.done) return false;
      this.chunk = String(next.value);
      this.index = 0;
      return true;
    };

    if (first === "{" || first === "[") {
      const stack = [first === "{" ? "}" : "]"];
      let inString = false;
      let escaped = false;
      while (true) {
        if (this.index >= this.chunk.length && !(await refill())) {
          throw new Error("Invalid legacy public share JSON: truncated value");
        }
        const start = this.index;
        while (this.index < this.chunk.length) {
          const character = this.chunk[this.index++]!;
          if (inString) {
            if (escaped) escaped = false;
            else if (character === "\\") escaped = true;
            else if (character === '"') inString = false;
          } else if (character === '"') {
            inString = true;
          } else if (character === "{") {
            stack.push("}");
          } else if (character === "[") {
            stack.push("]");
          } else if (character === stack.at(-1)) {
            stack.pop();
          } else if (character === "}" || character === "]") {
            throw new Error(
              "Invalid legacy public share JSON: mismatched value",
            );
          }
          if (stack.length === 0) {
            output += this.chunk.slice(start, this.index);
            await flush();
            return;
          }
        }
        output += this.chunk.slice(start, this.index);
      }
    }

    if (first === '"') {
      let escaped = false;
      while (true) {
        if (this.index >= this.chunk.length && !(await refill())) {
          throw new Error("Invalid legacy public share JSON: truncated string");
        }
        const start = this.index;
        while (this.index < this.chunk.length) {
          const character = this.chunk[this.index++]!;
          if (escaped) escaped = false;
          else if (character === "\\") escaped = true;
          else if (character === '"') {
            output += this.chunk.slice(start, this.index);
            await flush();
            return;
          }
        }
        output += this.chunk.slice(start, this.index);
      }
    }

    while (true) {
      if (this.index >= this.chunk.length && !(await refill())) {
        await flush();
        return;
      }
      const start = this.index;
      while (this.index < this.chunk.length) {
        const character = this.chunk[this.index]!;
        if (/\s/.test(character)) {
          output += this.chunk.slice(start, this.index);
          this.index += 1;
          await flush();
          return;
        }
        if (character === "," || character === "]" || character === "}") {
          output += this.chunk.slice(start, this.index);
          await flush();
          return;
        }
        this.index += 1;
      }
      output += this.chunk.slice(start, this.index);
    }
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
  const first = await nextNonWhitespace(reader);
  if (first === null) {
    throw new Error("Invalid legacy public share JSON: missing value");
  }
  await reader.copyValueFromFirst(first, consume);
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

async function writeBodyValue(
  reader: StreamingCharacterReader,
  temporaryDirectory: string,
  sequence: number,
): Promise<LegacySessionBody> {
  const filePath = path.join(temporaryDirectory, `body-${sequence}.json`);
  const handle = await fs.open(filePath, "wx", 0o600);
  let inString = false;
  let escaped = false;
  try {
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
      if (canonical) await handle.write(canonical, undefined, "utf8");
    });
    await handle.sync();
  } finally {
    await handle.close();
  }
  return { filePath };
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
  const snapshots: Record<string, LegacyViewerSnapshot> = {};
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
      );
    } else if (key === "viewerSnapshots") {
      viewerSnapshots = await parseViewerSnapshots(
        reader,
        temporaryDirectory,
        nextBodySequence,
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
): AsyncGenerator<LegacyPublicShareRecord> {
  await fs.mkdir(temporaryDirectory, { recursive: true, mode: 0o700 });
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
  filePath: string,
): Promise<{ repairRequired: boolean }> {
  const reader = new StreamingCharacterReader(filePath);
  let messageCount = 0;
  let messagesSeen = false;
  let messagesNonWhitespace = "";
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
        messagesSeen = true;
        await copyJsonValue(reader, (chunk) => {
          for (const character of chunk) {
            if (/\s/.test(character)) continue;
            if (messagesNonWhitespace.length < 3) {
              messagesNonWhitespace += character;
            }
          }
        });
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
        messageCount > 0 && (!messagesSeen || messagesNonWhitespace === "[]"),
    };
  } finally {
    await reader.close();
  }
}
