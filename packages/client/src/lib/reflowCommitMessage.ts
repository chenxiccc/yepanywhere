const SHORT_STRUCTURAL_LINE_MAX = 50;

const LIST_ITEM_START = /^\s*(?:[*\-•]|\d+\.)\s+/u;
const INDENTED_LINE = /^[ \t]/;

function isShortStructuralLine(line: string): boolean {
  return line.trimEnd().length <= SHORT_STRUCTURAL_LINE_MAX;
}

function keepsBreakBefore(line: string, predecessor: string): boolean {
  return (
    line.trim().length === 0 ||
    predecessor.trim().length === 0 ||
    LIST_ITEM_START.test(line) ||
    INDENTED_LINE.test(line) ||
    (isShortStructuralLine(line) && isShortStructuralLine(predecessor))
  );
}

/**
 * Turn likely manual prose wrapping into spaces so the compact commit-message
 * pane can wrap to its own width. Structural newlines remain explicit; the
 * full commit-message view deliberately bypasses this display projection.
 */
export function reflowCommitMessage(message: string): string {
  const lines = message.split("\n");
  if (lines.length < 2) return message;

  const firstLine = lines.shift();
  if (firstLine === undefined) return message;

  const reflowed: string[] = [];
  let displayLine = firstLine;
  let predecessor = firstLine;
  for (const line of lines) {
    if (keepsBreakBefore(line, predecessor)) {
      reflowed.push(displayLine);
      displayLine = line;
    } else {
      displayLine = `${displayLine.trimEnd()} ${line.trim()}`;
    }
    predecessor = line;
  }
  reflowed.push(displayLine);
  return reflowed.join("\n");
}
