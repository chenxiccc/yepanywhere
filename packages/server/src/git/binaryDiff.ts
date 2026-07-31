import { GIT_DECODE_PATHS_ARGS, runGit } from "./gitExec.js";

/**
 * Ask Git whether the exact selected projection is binary.
 *
 * The supplied args start with the Git subcommand and include its revisions
 * and options. `--numstat -z` reports binary sides as `-\t-\t...`, while Git
 * remains responsible for `.gitattributes` and diff-driver policy.
 */
export async function gitDiffReportsBinary(
  cwd: string,
  args: string[],
  path: string,
): Promise<boolean> {
  const [subcommand, ...rest] = args;
  if (!subcommand) {
    return false;
  }
  const { stdout } = await runGit(cwd, [
    ...GIT_DECODE_PATHS_ARGS,
    subcommand,
    "--numstat",
    "-z",
    ...rest,
    "--",
    path,
  ]);
  return numstatReportsBinary(stdout);
}

export function numstatReportsBinary(stdout: string): boolean {
  for (const record of stdout.split("\0")) {
    if (record.startsWith("-\t-\t")) {
      return true;
    }
  }
  return false;
}
