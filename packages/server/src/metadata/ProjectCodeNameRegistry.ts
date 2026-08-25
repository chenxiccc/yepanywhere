import {
  allocateProjectCodeName,
  normalizeProjectCodeName,
  projectCodeNameKey,
  projectCodeNamePrefixesProjectName,
  type ProjectCodeNameAssignment,
} from "@yep-anywhere/shared";

export interface ProjectCodeNameMetadata {
  codeName: string;
  projectName: string;
  source: "generated" | "manual";
  updatedAt: string;
}

export interface ProjectCodeNameUpdate {
  assignments: ProjectCodeNameAssignment[];
  changedProjectIds: string[];
}

interface MutableProjectCodeNameUpdate extends ProjectCodeNameUpdate {
  stateChanged: boolean;
}

type ProjectIdentity = (projectId: string) => string;

export function normalizeProjectCodeNameMetadata(
  metadata: ProjectCodeNameMetadata,
): ProjectCodeNameMetadata | undefined {
  if (!metadata || typeof metadata !== "object") return undefined;
  try {
    const codeName = normalizeProjectCodeName(metadata.codeName);
    const projectName =
      typeof metadata.projectName === "string" && metadata.projectName.trim()
        ? metadata.projectName.trim()
        : "project";
    const updatedAt = Number.isFinite(new Date(metadata.updatedAt).getTime())
      ? metadata.updatedAt
      : new Date(0).toISOString();
    const source = metadata.source === "manual" ? "manual" : "generated";
    return { codeName, projectName, source, updatedAt };
  } catch {
    return undefined;
  }
}

export function reconcileProjectCodeNames(
  records: Record<string, ProjectCodeNameMetadata>,
  projects: readonly { id: string; name: string }[],
  canonicalProjectId: ProjectIdentity,
): MutableProjectCodeNameUpdate {
  const projectNameById = new Map(
    projects.map((project) => [canonicalProjectId(project.id), project.name]),
  );
  const allProjectNamesById = new Map(
    Object.entries(records).map(([projectId, metadata]) => [
      projectId,
      metadata.projectName,
    ]),
  );
  for (const [projectId, projectName] of projectNameById) {
    allProjectNamesById.set(projectId, projectName);
  }

  const reserved = new Set<string>();
  const needsAllocation: Array<{ projectId: string; projectName: string }> = [];
  const needsAllocationIds = new Set<string>();
  const changedProjectIds = new Set<string>();
  let stateChanged = false;

  for (const projectId of Object.keys(records).sort(compareCodeUnits)) {
    const metadata = records[projectId];
    if (!metadata) continue;
    const key = projectCodeNameKey(metadata.codeName);
    const currentProjectName = projectNameById.get(projectId);
    const prefixesAnotherProject = [...allProjectNamesById].some(
      ([candidateProjectId, projectName]) =>
        candidateProjectId !== projectId &&
        projectCodeNamePrefixesProjectName(metadata.codeName, projectName),
    );
    if (
      reserved.has(key) ||
      (metadata.source !== "manual" && prefixesAnotherProject)
    ) {
      delete records[projectId];
      needsAllocation.push({
        projectId,
        projectName: currentProjectName ?? metadata.projectName,
      });
      needsAllocationIds.add(projectId);
      changedProjectIds.add(projectId);
      stateChanged = true;
      continue;
    }
    reserved.add(key);
    if (currentProjectName && currentProjectName !== metadata.projectName) {
      records[projectId] = { ...metadata, projectName: currentProjectName };
      stateChanged = true;
    }
  }

  for (const project of projects) {
    const projectId = canonicalProjectId(project.id);
    if (!records[projectId] && !needsAllocationIds.has(projectId)) {
      needsAllocation.push({ projectId, projectName: project.name });
      needsAllocationIds.add(projectId);
    }
  }

  needsAllocation.sort(
    (left, right) =>
      compareCodeUnits(left.projectName, right.projectName) ||
      compareCodeUnits(left.projectId, right.projectId),
  );
  const updatedAt = new Date().toISOString();
  for (const project of needsAllocation) {
    const codeName = allocateProjectCodeName(
      project.projectName,
      reserved,
      [...allProjectNamesById]
        .filter(([projectId]) => projectId !== project.projectId)
        .map(([, projectName]) => projectName),
    );
    records[project.projectId] = {
      codeName,
      projectName: project.projectName,
      source: "generated",
      updatedAt,
    };
    reserved.add(projectCodeNameKey(codeName));
    changedProjectIds.add(project.projectId);
    stateChanged = true;
  }

  return {
    assignments: projects.map((project) => {
      const codeName = records[canonicalProjectId(project.id)]?.codeName;
      if (!codeName) {
        throw new Error(
          `Project code-name allocation failed for ${project.id}`,
        );
      }
      return { projectId: project.id, codeName };
    }),
    changedProjectIds: [...changedProjectIds].sort(compareCodeUnits),
    stateChanged,
  };
}

export function setProjectCodeNameInRegistry(
  records: Record<string, ProjectCodeNameMetadata>,
  projectId: string,
  requestedCodeName: string,
  projects: readonly { id: string; name: string }[],
  canonicalProjectId: ProjectIdentity,
): MutableProjectCodeNameUpdate {
  const codeName = normalizeProjectCodeName(requestedCodeName);
  const canonicalId = canonicalProjectId(projectId);
  const project = projects.find(
    (candidate) => canonicalProjectId(candidate.id) === canonicalId,
  );
  if (!project) {
    throw new RangeError("Project is not available for code-name editing");
  }
  const reconciled = reconcileProjectCodeNames(
    records,
    projects,
    canonicalProjectId,
  );

  const requestedKey = projectCodeNameKey(codeName);
  const displaced = Object.entries(records)
    .filter(
      ([candidateProjectId, metadata]) =>
        candidateProjectId !== canonicalId &&
        projectCodeNameKey(metadata.codeName) === requestedKey,
    )
    .sort(([left], [right]) => compareCodeUnits(left, right));
  const changingIds = new Set([
    canonicalId,
    ...displaced.map(([candidateProjectId]) => candidateProjectId),
  ]);
  const reserved = new Set(
    Object.entries(records)
      .filter(([candidateProjectId]) => !changingIds.has(candidateProjectId))
      .map(([, metadata]) => metadata.codeName),
  );
  const updatedAt = new Date().toISOString();
  records[canonicalId] = {
    codeName,
    projectName: project.name,
    source: "manual",
    updatedAt,
  };
  reserved.add(codeName);

  const assignments: ProjectCodeNameAssignment[] = [
    { projectId: canonicalId, codeName },
  ];
  const changedProjectIds = new Set(reconciled.changedProjectIds);
  changedProjectIds.add(canonicalId);
  for (const [displacedProjectId, metadata] of displaced) {
    const replacement = allocateProjectCodeName(
      metadata.projectName,
      reserved,
      Object.entries(records)
        .filter(
          ([candidateProjectId]) => candidateProjectId !== displacedProjectId,
        )
        .map(([, candidateMetadata]) => candidateMetadata.projectName),
    );
    records[displacedProjectId] = {
      ...metadata,
      codeName: replacement,
      source: "generated",
      updatedAt,
    };
    reserved.add(replacement);
    assignments.push({ projectId: displacedProjectId, codeName: replacement });
    changedProjectIds.add(displacedProjectId);
  }

  return {
    assignments,
    changedProjectIds: [...changedProjectIds].sort(compareCodeUnits),
    stateChanged: true,
  };
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
