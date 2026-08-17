import { detectNestedHarnessLaunch } from "@yep-anywhere/shared";

/** Session context a transcript needs to resolve a launch into a YA link. */
export interface NestedHarnessLaunchContext {
  basePath: string;
  projectId: string;
  projectPath: string | null;
  sessionId: string;
}

export interface NestedHarnessLaunchTarget {
  sessionId: string;
  href: string;
}

function sameDirectory(left: string, right: string): boolean {
  const trim = (value: string) => value.replace(/\/+$/, "");
  return trim(left) === trim(right);
}

/**
 * The YA session a shell command launches a harness against, when the
 * transcript can name it. A launch that first `cd`s somewhere else resolves to
 * no target: the child then belongs to another project, and a path is not a
 * project id.
 */
export function nestedHarnessLaunchTarget(
  command: string,
  context: NestedHarnessLaunchContext,
): NestedHarnessLaunchTarget | undefined {
  const launch = detectNestedHarnessLaunch(command);
  const sessionId = launch?.sessionId;
  if (!sessionId || sessionId === context.sessionId) return undefined;
  if (
    launch?.workingDirectory &&
    !(
      context.projectPath &&
      sameDirectory(launch.workingDirectory, context.projectPath)
    )
  ) {
    return undefined;
  }
  const root = context.basePath.replace(/\/$/, "");
  return {
    sessionId,
    href: `${root}/projects/${context.projectId}/sessions/${sessionId}`,
  };
}
