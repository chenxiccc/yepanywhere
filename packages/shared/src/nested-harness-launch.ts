/**
 * Nested harness launches: one agent session starting a second harness process
 * from a shell tool call, rather than through the provider's own subagent
 * feature. No sidechain entry exists for that work, so the only durable record
 * of who started it is the launching command text.
 *
 * Contract: topics/nested-harness-launch.md
 */

/** Harness CLIs whose launch arguments YA reads. */
export type NestedHarnessName = "claude";

export interface NestedHarnessLaunch {
  harness: NestedHarnessName;
  /**
   * Session the launched process continues, when the command names one.
   * Absent for a fresh launch, whose new id the harness reports only in its
   * own task output file.
   */
  sessionId?: string;
  /** Directory an earlier `cd` in the same command moved to, when it does. */
  workingDirectory?: string;
}

const HARNESS_NAMES: readonly NestedHarnessName[] = ["claude"];
const HARNESS_NAME_SET = new Set<string>(HARNESS_NAMES);
/** Flags whose UUID value names the session the launched process will write. */
const SESSION_FLAGS = new Set(["--resume", "-r", "--session-id"]);
/** Flags that make the launch a one-shot run rather than an interactive TUI. */
const NON_INTERACTIVE_FLAGS = new Set(["-p", "--print"]);
/** Command prefixes that pass their remaining words through unchanged. */
const TRANSPARENT_PREFIXES = new Set(["env", "nohup", "setsid", "exec"]);
const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface HeredocBody {
  delimiter: string;
  stripTabs: boolean;
}

function baseName(word: string): string {
  const slash = word.lastIndexOf("/");
  return slash === -1 ? word : word.slice(slash + 1);
}

/**
 * The heredoc a redirection word opens, or undefined when it is not one.
 * `<<<` is a here-string, which has no body to skip.
 */
function readHeredocOperator(word: string): HeredocBody | undefined {
  if (!word.startsWith("<<") || word.startsWith("<<<")) return undefined;
  const rest = word.slice(2);
  const stripTabs = rest.startsWith("-");
  return { delimiter: stripTabs ? rest.slice(1) : rest, stripTabs };
}

/** Index just past the heredoc body starting at `from`. */
function skipHeredocBody(
  text: string,
  from: number,
  body: HeredocBody,
): number {
  let index = from;
  while (index < text.length) {
    const newline = text.indexOf("\n", index);
    const end = newline === -1 ? text.length : newline;
    let line = text.slice(index, end);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (body.stripTabs) line = line.replace(/^\t+/, "");
    index = newline === -1 ? text.length : newline + 1;
    if (line === body.delimiter) break;
  }
  return index;
}

/**
 * The command's simple commands, each as its argument words with quoting
 * removed. Splitting stops at the ordinary separators and skips heredoc
 * bodies, so command text quoted inside a commit message or a written file
 * cannot be read as an invocation. Words inside a quoted `sh -c` argument stay
 * one word and are deliberately not descended into.
 */
function splitSimpleCommands(command: string): string[][] {
  const commands: string[][] = [];
  const heredocs: HeredocBody[] = [];
  let words: string[] = [];
  let word = "";
  let started = false;
  let quote: "'" | '"' | undefined;
  let awaitingHeredocDelimiter: { stripTabs: boolean } | undefined;

  const endWord = (): void => {
    if (!started) return;
    const finished = word;
    word = "";
    started = false;
    if (awaitingHeredocDelimiter) {
      heredocs.push({
        delimiter: finished,
        stripTabs: awaitingHeredocDelimiter.stripTabs,
      });
      awaitingHeredocDelimiter = undefined;
      return;
    }
    const heredoc = readHeredocOperator(finished);
    if (heredoc) {
      if (heredoc.delimiter) heredocs.push(heredoc);
      else awaitingHeredocDelimiter = { stripTabs: heredoc.stripTabs };
      return;
    }
    words.push(finished);
  };

  const endCommand = (): void => {
    endWord();
    if (words.length) commands.push(words);
    words = [];
  };

  let index = 0;
  while (index < command.length) {
    const char = command[index] as string;
    if (quote === "'") {
      if (char === "'") quote = undefined;
      else {
        word += char;
        started = true;
      }
      index += 1;
      continue;
    }
    if (quote === '"') {
      if (char === "\\" && index + 1 < command.length) {
        word += command[index + 1];
        started = true;
        index += 2;
        continue;
      }
      if (char === '"') quote = undefined;
      else {
        word += char;
        started = true;
      }
      index += 1;
      continue;
    }
    if (char === "\\") {
      // A line continuation joins the next line onto the current word.
      if (command[index + 1] !== "\n") {
        word += command[index + 1] ?? "";
        started = true;
      }
      index += 2;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
      index += 1;
      continue;
    }
    if (char === "\n") {
      endCommand();
      index += 1;
      while (heredocs.length) {
        index = skipHeredocBody(
          command,
          index,
          heredocs.shift() as HeredocBody,
        );
      }
      continue;
    }
    // `2>&1` and `>&2` duplicate a descriptor; their `&` is not a separator.
    if (char === "&" && (word.endsWith(">") || word.endsWith("<"))) {
      word += char;
      index += 1;
      continue;
    }
    if (
      char === ";" ||
      char === "&" ||
      char === "|" ||
      char === "(" ||
      char === ")" ||
      char === "`"
    ) {
      endCommand();
      index += 1;
      continue;
    }
    if (char === " " || char === "\t" || char === "\r") {
      endWord();
      index += 1;
      continue;
    }
    word += char;
    started = true;
    index += 1;
  }
  endCommand();
  return commands;
}

function stripTransparentPrefix(words: string[]): string[] {
  let index = 0;
  while (index < words.length) {
    const word = words[index] as string;
    if (ASSIGNMENT_RE.test(word) || TRANSPARENT_PREFIXES.has(baseName(word))) {
      index += 1;
      continue;
    }
    break;
  }
  return words.slice(index);
}

function readHarnessArguments(
  harness: NestedHarnessName,
  args: string[],
): NestedHarnessLaunch | undefined {
  let sessionId: string | undefined;
  let nonInteractive = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    const equals = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const flag = equals > 0 ? arg.slice(0, equals) : arg;
    const attached = equals > 0 ? arg.slice(equals + 1) : undefined;
    if (SESSION_FLAGS.has(flag)) {
      const value = attached ?? args[index + 1];
      if (value && UUID_RE.test(value)) {
        sessionId = value.toLowerCase();
        if (attached === undefined) index += 1;
      }
      continue;
    }
    if (NON_INTERACTIVE_FLAGS.has(flag)) nonInteractive = true;
  }
  if (!sessionId && !nonInteractive) return undefined;
  return sessionId ? { harness, sessionId } : { harness };
}

/**
 * The nested harness session a shell command starts, or undefined when the
 * command is something else. `claude --version` and a mention of `claude` in
 * an argument are both something else: the harness has to be the command word,
 * and it has to either name a session or run non-interactively.
 */
export function detectNestedHarnessLaunch(
  command: string,
): NestedHarnessLaunch | undefined {
  if (!HARNESS_NAMES.some((harness) => command.includes(harness))) {
    return undefined;
  }
  let workingDirectory: string | undefined;
  for (const simpleCommand of splitSimpleCommands(command)) {
    const args = stripTransparentPrefix(simpleCommand);
    const name = args[0];
    if (!name) continue;
    if (name === "cd") {
      const target = args[1];
      if (target && !target.startsWith("-")) workingDirectory = target;
      continue;
    }
    if (!HARNESS_NAME_SET.has(baseName(name))) continue;
    const launch = readHarnessArguments(
      baseName(name) as NestedHarnessName,
      args.slice(1),
    );
    if (!launch) continue;
    return workingDirectory ? { ...launch, workingDirectory } : launch;
  }
  return undefined;
}
