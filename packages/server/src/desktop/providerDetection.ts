import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ProviderName } from "@yep-anywhere/shared";

export interface DesktopProviderDetectionOptions {
  platform?: NodeJS.Platform;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  exists?: (candidate: string) => boolean;
  readDirectories?: (candidate: string) => string[];
}

function safeDirectoryNames(candidate: string): string[] {
  try {
    return fs
      .readdirSync(candidate, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/**
 * Coarse, read-only signal for the desktop notice. This deliberately accepts
 * provider-owned config/data as evidence while leaving actual launchability
 * to the ordinary provider catalog.
 */
export function detectDesktopProviderApplication(
  provider: ProviderName,
  options: DesktopProviderDetectionOptions = {},
): boolean {
  if (provider !== "claude" && provider !== "codex") return false;

  const platform = options.platform ?? process.platform;
  const homeDir = options.homeDir ?? os.homedir();
  const env = options.env ?? process.env;
  const exists = options.exists ?? fs.existsSync;
  const readDirectories = options.readDirectories ?? safeDirectoryNames;
  const appName = provider === "claude" ? "Claude" : "Codex";
  const candidates: string[] = [
    path.join(homeDir, provider === "claude" ? ".claude" : ".codex"),
  ];

  if (platform === "win32") {
    const localAppData =
      env.LOCALAPPDATA ?? path.join(homeDir, "AppData", "Local");
    const appData = env.APPDATA ?? path.join(homeDir, "AppData", "Roaming");
    if (provider === "claude") {
      candidates.push(
        path.join(localAppData, "Claude-3p"),
        path.join(localAppData, "Programs", "Claude"),
        path.join(appData, "Claude"),
        path.join(appData, "Claude Code"),
      );
      const packages = path.join(localAppData, "Packages");
      if (
        readDirectories(packages).some((entry) =>
          entry.toLowerCase().startsWith("claude_"),
        )
      ) {
        return true;
      }
    } else {
      candidates.push(
        path.join(localAppData, "OpenAI", "Codex"),
        path.join(localAppData, "Programs", "Codex"),
        path.join(appData, "Codex"),
      );
    }
  } else if (platform === "darwin") {
    candidates.push(
      path.join("/Applications", `${appName}.app`),
      path.join(homeDir, "Applications", `${appName}.app`),
      path.join(homeDir, "Library", "Application Support", appName),
    );
  } else {
    candidates.push(
      path.join(homeDir, ".config", appName),
      path.join(homeDir, ".config", appName.toLowerCase()),
      path.join(
        homeDir,
        ".local",
        "share",
        "applications",
        `${provider}.desktop`,
      ),
    );
  }

  return candidates.some((candidate) => exists(candidate));
}
