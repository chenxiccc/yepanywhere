import type { GitFileChange } from "@yep-anywhere/shared";

interface NameStatusEntry {
  status: string;
  path: string;
  origPath?: string;
}

/**
 * `--name-status` and `--numstat` list the same files in the same order for a
 * given diff, so counts are zipped by index. This also avoids parsing
 * numstat's `old => new` rename path form.
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

function parseNameStatus(stdout: string): NameStatusEntry[] {
  const out: NameStatusEntry[] = [];
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    const parts = line.split("\t");
    const letter = (parts[0] ?? "M")[0] ?? "M";
    if (letter === "R" || letter === "C") {
      const origPath = parts[1];
      const path = parts[2];
      if (!path) continue;
      out.push({ status: letter, path, origPath });
    } else {
      const path = parts[1];
      if (!path) continue;
      out.push({ status: letter, path });
    }
  }
  return out;
}

function parseNumstatCounts(
  stdout: string,
): Array<{ added: number | null; deleted: number | null }> {
  const out: Array<{ added: number | null; deleted: number | null }> = [];
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    const parts = line.split("\t");
    const added = parts[0];
    const deleted = parts[1];
    out.push({
      added: added === "-" || added === undefined ? null : toCount(added),
      deleted:
        deleted === "-" || deleted === undefined ? null : toCount(deleted),
    });
  }
  return out;
}

function toCount(value: string): number | null {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
}
