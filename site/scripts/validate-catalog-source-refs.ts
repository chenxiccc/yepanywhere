import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { distributions } from "../src/data/distributions.js";
import { features } from "../src/data/features.js";
import { providers } from "../src/data/providers.js";

interface SourceEntry {
  id: string;
  sourceRefs: readonly string[];
}

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

function requireExistingSourceRefs(
  label: string,
  entries: readonly SourceEntry[],
): void {
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

requireExistingSourceRefs("Feature", features);
requireExistingSourceRefs("Provider", providers);
requireExistingSourceRefs("Distribution", distributions);

console.log(
  `Validated repository source references for ${features.length} features, ${providers.length} providers, and ${distributions.length} distributions.`,
);
