import type { ProviderName, UrlProjectId } from "@yep-anywhere/shared";
import type { SessionMetadata } from "../metadata/SessionMetadataService.js";
import { encodeProjectId } from "../projects/paths.js";
import type { ProjectScanner } from "../projects/scanner.js";
import {
  findNativeSessionProjectAcrossProviders,
  findSessionListSummaryAcrossProviders,
  type ProviderResolutionDeps,
} from "../sessions/provider-resolution.js";
import type { Project } from "../supervisor/types.js";

export interface ExistingSessionIdentity {
  provider: ProviderName;
  transcriptProject: Project;
  transcriptProjectId: UrlProjectId;
  workingProject: Project;
  workingProjectId: UrlProjectId;
  source: "native" | "metadata" | "request";
}

export async function resolveExistingSessionIdentity(options: {
  sessionId: string;
  requestProjectId: UrlProjectId;
  preferredProvider?: ProviderName;
  requestFallbackProvider?: ProviderName;
  metadata?: SessionMetadata;
  scanner: Pick<ProjectScanner, "getOrCreateProject">;
  providerDeps: ProviderResolutionDeps;
}): Promise<ExistingSessionIdentity | null> {
  const {
    sessionId,
    requestProjectId,
    preferredProvider,
    requestFallbackProvider,
    metadata,
    scanner,
    providerDeps,
  } = options;
  const providerPreference = preferredProvider ?? metadata?.provider;

  const finish = async (
    transcriptProject: Project,
    transcriptProjectId: UrlProjectId,
    provider: ProviderName,
    source: ExistingSessionIdentity["source"],
  ): Promise<ExistingSessionIdentity | null> => {
    const workingProjectId = metadata?.workingProjectId ?? transcriptProjectId;
    const workingProject =
      workingProjectId === transcriptProjectId
        ? transcriptProject
        : await scanner.getOrCreateProject(workingProjectId);
    return workingProject
      ? {
          provider,
          transcriptProject,
          transcriptProjectId,
          workingProject,
          workingProjectId,
          source,
        }
      : null;
  };

  const resolveNativeIdentity =
    async (): Promise<ExistingSessionIdentity | null> => {
      const native = await findNativeSessionProjectAcrossProviders(
        sessionId,
        providerDeps,
        providerPreference,
      );
      if (!native) return null;
      const transcriptProjectId = encodeProjectId(native.projectPath);
      const transcriptProject =
        await scanner.getOrCreateProject(transcriptProjectId);
      return transcriptProject
        ? finish(
            transcriptProject,
            transcriptProjectId,
            providerPreference ?? native.provider,
            "native",
          )
        : null;
    };
  if (providerPreference) {
    const nativeIdentity = await resolveNativeIdentity();
    if (nativeIdentity) return nativeIdentity;
  }

  const candidateProjectIds = [
    metadata?.transcriptProjectId,
    requestProjectId,
  ].filter(
    (candidate, index, values): candidate is UrlProjectId =>
      candidate !== undefined && values.indexOf(candidate) === index,
  );
  for (const candidateProjectId of candidateProjectIds) {
    const candidateProject =
      await scanner.getOrCreateProject(candidateProjectId);
    if (!candidateProject) continue;
    const resolved = await findSessionListSummaryAcrossProviders(
      candidateProject,
      sessionId,
      candidateProjectId,
      providerDeps,
      providerPreference,
    );
    if (!resolved) continue;
    return finish(
      candidateProject,
      candidateProjectId,
      providerPreference ?? resolved.source.provider,
      candidateProjectId === metadata?.transcriptProjectId
        ? "metadata"
        : "request",
    );
  }

  if (!providerPreference) {
    const nativeIdentity = await resolveNativeIdentity();
    if (nativeIdentity) return nativeIdentity;
  }

  const nativeResolutionAvailable =
    providerPreference === "codex" || providerPreference === "codex-oss"
      ? Boolean(providerDeps.codexScanner || providerDeps.codexSessionsDir)
      : providerPreference === "grok"
        ? Boolean(providerDeps.grokSessionsDir)
        : providerPreference === "pi"
          ? Boolean(providerDeps.piSessionsDir)
          : false;
  const fallbackProvider = providerPreference ?? requestFallbackProvider;
  if (fallbackProvider && !nativeResolutionAvailable) {
    const requestProject = await scanner.getOrCreateProject(requestProjectId);
    if (requestProject) {
      return finish(
        requestProject,
        requestProjectId,
        fallbackProvider,
        "request",
      );
    }
  }

  return null;
}
