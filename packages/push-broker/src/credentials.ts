import {
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const ID_BYTES = 16;
const SECRET_BYTES = 32;
const ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const DUMMY_HASH = Buffer.alloc(32);

export function generateOpaqueId(): string {
  return randomBytes(ID_BYTES).toString("base64url");
}

export function generateSecret(): string {
  return randomBytes(SECRET_BYTES).toString("base64url");
}

export function hashSecret(secret: string): Buffer {
  return createHash("sha256").update(secret, "utf8").digest();
}

export function verifySecret(
  presentedSecret: string,
  expectedHash: Buffer | undefined,
): boolean {
  const presentedHash = hashSecret(presentedSecret);
  return timingSafeEqual(presentedHash, expectedHash ?? DUMMY_HASH);
}

export function isOpaqueId(value: string): boolean {
  return ID_PATTERN.test(value);
}

export function isGeneratedSecret(value: string): boolean {
  return SECRET_PATTERN.test(value);
}
