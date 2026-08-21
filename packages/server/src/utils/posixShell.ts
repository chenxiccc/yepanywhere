/**
 * Quote one value as a single literal POSIX shell word.
 *
 * Canonical owner of the single-quote escaping invariant. Every POSIX
 * shell-word producer (remote launch commands, login command formatting,
 * session-environment publication) must use this helper rather than
 * carrying its own copy of the escape rule.
 */
export function quoteShellWord(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
