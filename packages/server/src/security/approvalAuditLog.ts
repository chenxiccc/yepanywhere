import { createReadStream, createWriteStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import type { InputRequest, UserQuestionAnswers } from "@yep-anywhere/shared";
import { enforceOwnerReadWriteFilePermissions } from "../utils/filePermissions.js";

export const APPROVAL_AUDIT_LOG_MAX_BYTES = 25 * 1024 * 1024;
const APPROVAL_AUDIT_LOG_NAME = "approval-decisions.jsonl";

let appendQueue = Promise.resolve();
let rotationSequence = 0;

export interface ApprovalAuditEntry {
  timestamp: string;
  sessionId: string;
  processId: string;
  provider?: string;
  requestId: string;
  request: InputRequest | null;
  response: string;
  normalizedResponse: "approve" | "deny";
  answers?: UserQuestionAnswers;
  feedback?: string;
  accepted: boolean;
  failure?: string;
  permissionModeBefore: string;
  permissionModeAfter: string;
}

export async function appendApprovalAuditLog(
  dataDir: string | undefined,
  entry: ApprovalAuditEntry,
): Promise<void> {
  appendQueue = appendQueue
    .catch(() => undefined)
    .then(() => appendApprovalAuditLogNow(dataDir, entry));
  return appendQueue;
}

async function appendApprovalAuditLogNow(
  dataDir: string | undefined,
  entry: ApprovalAuditEntry,
): Promise<void> {
  if (!dataDir) return;

  const dir = path.join(dataDir, "logs");
  const filePath = path.join(dir, APPROVAL_AUDIT_LOG_NAME);
  const line = `${JSON.stringify(entry)}\n`;
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    await fs.chmod(dir, 0o700);
  }
  const archivePath = await rotateApprovalAuditLogIfNeeded(
    filePath,
    Buffer.byteLength(line),
  );
  await fs.appendFile(filePath, line, { mode: 0o600 });
  await enforceOwnerReadWriteFilePermissions(filePath, "[approval-audit]");
  if (archivePath) {
    await gzipRotatedApprovalAuditLog(archivePath);
  }
}

async function rotateApprovalAuditLogIfNeeded(
  filePath: string,
  nextLineBytes: number,
): Promise<string | undefined> {
  let stats: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stats = await fs.stat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }

  if (
    !stats.isFile() ||
    stats.size + nextLineBytes <= APPROVAL_AUDIT_LOG_MAX_BYTES
  ) {
    return undefined;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  rotationSequence += 1;
  const sequence = rotationSequence;
  const archivePath = path.join(
    path.dirname(filePath),
    `approval-decisions.${timestamp}.${process.pid}-${sequence}.jsonl`,
  );

  try {
    await fs.rename(filePath, archivePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  await enforceOwnerReadWriteFilePermissions(archivePath, "[approval-audit]");
  return archivePath;
}

async function gzipRotatedApprovalAuditLog(archivePath: string): Promise<void> {
  const gzipPath = `${archivePath}.gz`;
  try {
    await pipeline(
      createReadStream(archivePath),
      createGzip(),
      createWriteStream(gzipPath, { mode: 0o600 }),
    );
    await enforceOwnerReadWriteFilePermissions(gzipPath, "[approval-audit]");
    await fs.rm(archivePath, { force: true });
  } catch {
    await fs.rm(gzipPath, { force: true }).catch(() => undefined);
  }
}
