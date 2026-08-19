import type { GitFileChange } from "@yep-anywhere/shared";
import { GIT_DECODE_PATHS_ARGS, runGit } from "./gitExec.js";

interface NameStatusEntry {
  status: string;
  path: string;
  origPath?: string;
}

/**
 * NUL-delimited `--name-status -z` and `--numstat -z` list the same files in
 * the same order for a given diff, so counts are zipped by index. NUL
 * delimiters preserve every legal Git path, including tabs and newlines.
 */
export function buildGitFileChanges(
  nameStatus: string,
  numstat: string,
): GitFileChange[] {
  const entries = parseNameStatus(nameStatus);
  const counts = parseNumstatCounts(numstat);
  return entries.map((entry, index) => {
    const file: GitFileChange = {
      path: entry.path,
      status: entry.status,
      staged: false,
      linesAdded: counts[index]?.added ?? null,
      linesDeleted: counts[index]?.deleted ?? null,
    };
    if (entry.origPath) file.origPath = entry.origPath;
    return file;
  });
}

/** Read one exact Git diff's file corpus with rename and line-count metadata. */
export async function readGitDiffFileChanges(
  cwd: string,
  revisions: readonly string[],
  options?: { maxBuffer?: number; paths?: readonly string[] },
): Promise<GitFileChange[]> {
  const args = [...GIT_DECODE_PATHS_ARGS, "diff", "--no-ext-diff", "-M"];
  const pathspecs = options?.paths?.map((path) => `:(literal)${path}`) ?? [];
  const runOptions = options?.maxBuffer
    ? { maxBuffer: options.maxBuffer }
    : undefined;
  const scopedArgs =
    pathspecs.length > 0 ? [...revisions, "--", ...pathspecs] : revisions;
  const [nameStatus, numstat] = await Promise.all([
    runGit(cwd, [...args, "--name-status", "-z", ...scopedArgs], runOptions),
    runGit(cwd, [...args, "--numstat", "-z", ...scopedArgs], runOptions),
  ]);
  return buildGitFileChanges(nameStatus.stdout, numstat.stdout);
}

function parseNameStatus(stdout: string): NameStatusEntry[] {
  const tokens = splitNullDelimited(stdout);
  const out: NameStatusEntry[] = [];
  for (let index = 0; index < tokens.length; ) {
    const status = tokens[index++];
    if (!status) continue;
    const letter = status[0] ?? "M";
    if (letter === "R" || letter === "C") {
      const origPath = tokens[index++];
      const path = tokens[index++];
      if (origPath === undefined || path === undefined) break;
      out.push({ status: letter, path, origPath });
    } else {
      const path = tokens[index++];
      if (path === undefined) break;
      out.push({ status: letter, path });
    }
  }
  return out;
}

function parseNumstatCounts(
  stdout: string,
): Array<{ added: number | null; deleted: number | null }> {
  const tokens = splitNullDelimited(stdout);
  const out: Array<{ added: number | null; deleted: number | null }> = [];
  for (let index = 0; index < tokens.length; ) {
    const record = tokens[index++];
    if (!record) continue;
    const firstTab = record.indexOf("\t");
    const secondTab = firstTab < 0 ? -1 : record.indexOf("\t", firstTab + 1);
    if (firstTab < 0 || secondTab < 0) continue;
    const added = record.slice(0, firstTab);
    const deleted = record.slice(firstTab + 1, secondTab);
    out.push({
      added: added === "-" ? null : toCount(added),
      deleted: deleted === "-" ? null : toCount(deleted),
    });
    // For renames/copies, numstat writes an empty path field followed by the
    // old and new paths as separate NUL-delimited tokens.
    if (record.length === secondTab + 1) index += 2;
  }
  return out;
}

function splitNullDelimited(stdout: string): string[] {
  const tokens = stdout.split("\0");
  if (tokens.at(-1) === "") tokens.pop();
  return tokens;
}

function toCount(value: string): number | null {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
}
