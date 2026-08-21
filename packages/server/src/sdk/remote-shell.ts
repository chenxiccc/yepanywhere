import { quoteShellWord } from "../utils/posixShell.js";

/**
 * Quote a remote path while preserving only the deliberate $HOME expansion.
 * The rest of the path remains one literal shell word.
 */
export function quoteRemotePath(path: string): string {
  if (path === "$HOME") {
    return '"$HOME"';
  }
  if (path.startsWith("$HOME/")) {
    return `"$HOME"${quoteShellWord(path.slice("$HOME".length))}`;
  }
  return quoteShellWord(path);
}
