import { TextDecoder } from "node:util";

const MAX_SUSPICIOUS_TEXT_CONTROL_RATIO = 0.01;
const UTF8_TEXT_DECODER = new TextDecoder("utf-8", { fatal: true });

function isAllowedTextControlCode(codePoint: number): boolean {
  return (
    codePoint === 0x08 || // backspace, used by some terminal progress output
    codePoint === 0x09 ||
    codePoint === 0x0a ||
    codePoint === 0x0c ||
    codePoint === 0x0d ||
    codePoint === 0x1b
  );
}

/**
 * Decode bytes only when they are safe to present as UTF-8 text.
 *
 * NULs, malformed UTF-8, and a high density of terminal-unfriendly control
 * characters indicate binary content. The policy intentionally describes
 * display safety rather than file extensions or MIME guesses.
 */
export function decodeLikelyUtf8Text(buffer: Uint8Array): string | null {
  if (buffer.length === 0) {
    return "";
  }
  if (buffer.includes(0)) {
    return null;
  }

  let text: string;
  try {
    text = UTF8_TEXT_DECODER.decode(buffer);
  } catch {
    return null;
  }

  let suspiciousControls = 0;
  for (const char of text) {
    const codePoint = char.codePointAt(0);
    if (codePoint === undefined) {
      continue;
    }
    if (
      (codePoint < 0x20 && !isAllowedTextControlCode(codePoint)) ||
      codePoint === 0x7f
    ) {
      suspiciousControls += 1;
    }
  }

  return suspiciousControls / Math.max(text.length, 1) <=
    MAX_SUSPICIOUS_TEXT_CONTROL_RATIO
    ? text
    : null;
}

export function isLikelyUtf8Text(buffer: Uint8Array): boolean {
  return decodeLikelyUtf8Text(buffer) !== null;
}
