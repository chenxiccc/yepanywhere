import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

/** Process identity checks used to reject stale installation records safely. */
export interface InstallationOwnerProbe {
  /** Whether any process currently occupies the PID. */
  aliveState(pid: number): "alive" | "missing" | "other-user";
  /** Platform start identity for the PID; null when unavailable. */
  startId(pid: number): Promise<string | null>;
}

interface DefaultOwnerProbeOptions {
  platform?: NodeJS.Platform;
  execFile?: (
    command: string,
    args: string[],
    options: { encoding: "utf8"; timeout: number },
  ) => Promise<{ stdout: string }>;
}

const execFileAsync = promisify(execFile);

export function createDefaultOwnerProbe(
  options: DefaultOwnerProbeOptions = {},
): InstallationOwnerProbe {
  const platform = options.platform ?? process.platform;
  const runFile =
    options.execFile ??
    (async (command, args, commandOptions) => {
      const { stdout } = await execFileAsync(command, args, commandOptions);
      return { stdout: String(stdout) };
    });

  return {
    aliveState(pid: number): "alive" | "missing" | "other-user" {
      try {
        process.kill(pid, 0);
        return "alive";
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EPERM") {
          return "other-user";
        }
        return "missing";
      }
    },

    async startId(pid: number): Promise<string | null> {
      if (platform === "linux") {
        try {
          const statLine = await readFile(`/proc/${pid}/stat`, "utf8");
          // Fields after the parenthesized comm: overall field 22 is the
          // process start time in clock ticks since boot.
          const afterComm = statLine.slice(statLine.lastIndexOf(")") + 2);
          const startTime = afterComm.split(" ")[19];
          return startTime || null;
        } catch {
          return null;
        }
      }
      if (platform !== "win32") {
        // macOS and other POSIX hosts have no /proc; ps runs only on the rare
        // stale-cleanup path, never per admission.
        try {
          const { stdout } = await runFile(
            "ps",
            ["-p", String(pid), "-o", "lstart="],
            { encoding: "utf8", timeout: 5_000 },
          );
          return stdout.trim() || null;
        } catch {
          return null;
        }
      }
      try {
        const { stdout } = await runFile(
          "powershell.exe",
          [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `((Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks)`,
          ],
          { encoding: "utf8", timeout: 5_000 },
        );
        return stdout.trim() || null;
      } catch {
        return null;
      }
    },
  };
}

export const defaultOwnerProbe = createDefaultOwnerProbe();
