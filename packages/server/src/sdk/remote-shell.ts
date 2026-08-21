/** Quote one value as a single POSIX shell word. */
export function quoteShellWord(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

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
