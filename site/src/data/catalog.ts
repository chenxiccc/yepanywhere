import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { distributions } from "./distributions";
import { publishedDocPaths } from "./docs-navigation";
import { featureCategories, features, type PublicFeature } from "./features";
import { ALL_PROVIDERS, providers } from "./providers";
import type { PublicDistribution } from "./distributions";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));

function requireUniqueIds(label: string, entries: readonly { id: string }[]) {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.id)) throw new Error(`Duplicate ${label} id: ${entry.id}`);
    seen.add(entry.id);
  }
}

function requireExistingSourceRefs(
  label: string,
  entries: readonly { id: string; sourceRefs: readonly string[] }[],
) {
  for (const entry of entries) {
    for (const sourceRef of entry.sourceRefs) {
      const sourcePath = resolve(repositoryRoot, sourceRef);
      const relativeSourcePath = relative(repositoryRoot, sourcePath);
      if (
        !sourceRef ||
        isAbsolute(relativeSourcePath) ||
        relativeSourcePath === ".." ||
        relativeSourcePath.startsWith(`..${sep}`)
      ) {
        throw new Error(
          `${label} ${entry.id} has non-repository source reference ${sourceRef}`,
        );
      }
      if (!existsSync(sourcePath)) {
        throw new Error(
          `${label} ${entry.id} has missing source reference ${sourceRef}`,
        );
      }
    }
  }
}

export function validateCatalog() {
  requireUniqueIds("feature", features);
  requireUniqueIds("feature category", featureCategories);
  requireUniqueIds("provider", providers);
  requireUniqueIds("distribution", distributions);
  requireExistingSourceRefs("Feature", features);
  requireExistingSourceRefs("Provider", providers);
  requireExistingSourceRefs("Distribution", distributions);

  const categoryIds = new Set(featureCategories.map((category) => category.id));
  const providerIds = new Set(providers.map((provider) => provider.id));
  const coveredRuntimeProviderIds = new Set(
    providers.flatMap((provider) => provider.runtimeIds),
  );

  for (const runtimeProviderId of ALL_PROVIDERS) {
    if (!coveredRuntimeProviderIds.has(runtimeProviderId)) {
      throw new Error(
        `Runtime provider ${runtimeProviderId} is missing from the public provider registry`,
      );
    }
  }
  for (const runtimeProviderId of coveredRuntimeProviderIds) {
    if (!ALL_PROVIDERS.includes(runtimeProviderId)) {
      throw new Error(
        `Public provider registry references unknown runtime provider ${runtimeProviderId}`,
      );
    }
  }

  for (const feature of features as readonly PublicFeature[]) {
    if (!categoryIds.has(feature.category)) {
      throw new Error(`Feature ${feature.id} has unknown category ${feature.category}`);
    }
    if (!publishedDocPaths.has(feature.docsPath)) {
      throw new Error(
        `Feature ${feature.id} has unpublished docs path ${feature.docsPath}`,
      );
    }
    if (feature.featured && !feature.summary) {
      throw new Error(`Featured feature ${feature.id} needs a summary`);
    }
    for (const providerId of feature.providers ?? []) {
      if (!providerIds.has(providerId)) {
        throw new Error(`Feature ${feature.id} has unknown provider ${providerId}`);
      }
    }
  }

  for (const distribution of distributions as readonly PublicDistribution[]) {
    if (!publishedDocPaths.has(distribution.docsPath)) {
      throw new Error(
        `Distribution ${distribution.id} has unpublished docs path ${distribution.docsPath}`,
      );
    }
    if (distribution.status === "development" && distribution.downloadUrl) {
      throw new Error(
        `Development distribution ${distribution.id} cannot have a download URL`,
      );
    }
  }
}

validateCatalog();

export { distributions, featureCategories, features, providers };
