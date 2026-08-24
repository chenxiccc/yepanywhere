export const MAX_PROJECT_CODE_NAME_LENGTH = 12;

const PROJECT_CODE_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

export interface ProjectCodeNameChangedEvent {
  type: "project-code-names-changed";
  projectIds: string[];
  timestamp: string;
}

export interface ProjectCodeNameAssignment {
  projectId: string;
  codeName: string;
}

export function normalizeProjectCodeName(value: string): string {
  const codeName = value.trim();
  if (!codeName) {
    throw new RangeError("Project code name must not be empty");
  }
  if (codeName.length > MAX_PROJECT_CODE_NAME_LENGTH) {
    throw new RangeError(
      `Project code name must be at most ${MAX_PROJECT_CODE_NAME_LENGTH} characters`,
    );
  }
  if (!PROJECT_CODE_NAME_PATTERN.test(codeName)) {
    throw new RangeError(
      "Project code name may contain only letters, numbers, underscores, and hyphens",
    );
  }
  return codeName;
}

export function projectCodeNameKey(value: string): string {
  return value.toLowerCase();
}

function automaticProjectCodeNameCharacters(projectName: string): string[] {
  const normalized = projectName
    .normalize("NFKD")
    .replace(/\p{Mark}/gu, "")
    .toLowerCase();
  return [...normalized].filter((character) => /[a-z0-9]/.test(character));
}

function* threeCharacterCandidates(
  characters: readonly string[],
): Generator<string> {
  for (let second = 1; second < characters.length - 1; second++) {
    for (let third = second + 1; third < characters.length; third++) {
      yield `${characters[0]}${characters[second]}${characters[third]}`;
    }
  }
}

export function projectCodeNamePrefixesProjectName(
  codeName: string,
  projectName: string,
): boolean {
  const normalizedProjectName =
    automaticProjectCodeNameCharacters(projectName).join("");
  return normalizedProjectName.startsWith(projectCodeNameKey(codeName));
}

export function allocateProjectCodeName(
  projectName: string,
  reservedCodeNames: Iterable<string>,
  conflictingProjectNames: Iterable<string> = [],
): string {
  const reserved = new Set(
    [...reservedCodeNames].map((codeName) => projectCodeNameKey(codeName)),
  );
  const conflictingNames = [...conflictingProjectNames];
  const isUnavailable = (candidate: string) =>
    reserved.has(projectCodeNameKey(candidate)) ||
    conflictingNames.some((name) =>
      projectCodeNamePrefixesProjectName(candidate, name),
    );
  const characters = automaticProjectCodeNameCharacters(projectName);
  const distinctCandidates = new Set<string>();

  if (characters.length >= 3) {
    const defaultCandidate = characters.slice(0, 3).join("");
    distinctCandidates.add(defaultCandidate);
    if (!isUnavailable(defaultCandidate)) return defaultCandidate;

    if (characters.length >= 4) {
      const extendedCandidate = characters.slice(0, 4).join("");
      distinctCandidates.add(extendedCandidate);
      if (!isUnavailable(extendedCandidate)) {
        return extendedCandidate;
      }
    }
    for (const candidate of threeCharacterCandidates(characters)) {
      if (distinctCandidates.has(candidate)) continue;
      distinctCandidates.add(candidate);
      if (!isUnavailable(candidate)) return candidate;
    }
  } else {
    const candidate = characters.join("") || "prj";
    if (!isUnavailable(candidate)) return candidate;
  }

  const prefix =
    characters.length >= 2
      ? `${characters[0]}${characters[1]}`
      : characters.join("") || "pr";
  for (let suffix = 2; ; suffix++) {
    const candidate = `${prefix}${suffix}`;
    if (!isUnavailable(candidate)) return candidate;
  }
}
