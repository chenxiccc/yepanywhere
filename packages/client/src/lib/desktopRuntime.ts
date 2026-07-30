export interface DesktopRuntimeMetadata {
  desktopVersion: string;
  bundledYaVersion?: string;
  commit?: string;
}

declare global {
  interface Window {
    __YEP_DESKTOP_RUNTIME__?: unknown;
  }
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed !== "unknown" ? trimmed : undefined;
}

export function getDesktopRuntimeMetadata(): DesktopRuntimeMetadata | null {
  if (typeof window === "undefined") return null;
  const candidate = window.__YEP_DESKTOP_RUNTIME__;
  if (!candidate || typeof candidate !== "object") return null;

  const values = candidate as Record<string, unknown>;
  const desktopVersion = optionalString(values.desktopVersion);
  if (!desktopVersion) return null;

  return {
    desktopVersion,
    bundledYaVersion: optionalString(values.bundledYaVersion),
    commit: optionalString(values.commit),
  };
}

export function formatDesktopBuildVersion(version: string): string {
  const trimmed = version.trim();
  if (/^v\d+\.\d+\.\d+/.test(trimmed)) return trimmed;
  if (/^\d+\.\d+\.\d+/.test(trimmed)) return `v${trimmed}`;
  return trimmed;
}
