import { canonicalizeToolName, getExplorationKind } from "../toolNames";
import type {
  ExplorationEntry,
  ExplorationParent,
} from "./explorationProjection";

const GROUP_HEADER_HEIGHT_PX = 26;
const GROUP_BODY_CHROME_PX = 4;
const GROUP_BODY_MAX_HEIGHT_PX = 136;
const GROUP_ROW_HEIGHT_PX = 24;
const GROUP_ROW_GAP_PX = 2;

export function isCanonicalExplorationEntry(
  parent: ExplorationParent,
  entry: ExplorationEntry,
): boolean {
  return (
    parent.entries.length === 1 &&
    getExplorationKind(parent.item.toolName) === entry.kind
  );
}

export function getExplorationEntryDisplayLabel(
  parent: ExplorationParent,
  entry: ExplorationEntry,
): string {
  if (isCanonicalExplorationEntry(parent, entry)) {
    if (
      entry.kind === "search" &&
      canonicalizeToolName(parent.item.toolName) === "Grep"
    ) {
      return "Grep";
    }
    if (entry.kind === "list") return "List";
    return entry.kind === "search" ? "Search" : "Read";
  }

  if (entry.kind === "search") return "Search";
  return entry.kind === "list" ? "List" : "Read";
}

export function getExplorationEntryRangeText(entry: ExplorationEntry): string {
  if (entry.startLine === undefined) return "";
  return entry.endLine !== undefined && entry.endLine !== entry.startLine
    ? `lines ${entry.startLine}-${entry.endLine}`
    : `line ${entry.startLine}`;
}

export function getExplorationEntrySummaryText(
  entry: ExplorationEntry,
): string {
  if (entry.kind === "read") {
    const path = entry.path ?? entry.absolutePath ?? entry.name ?? "file";
    return [path, getExplorationEntryRangeText(entry)]
      .filter(Boolean)
      .join(" ");
  }
  if (entry.kind === "search") {
    return entry.path
      ? `${entry.query ?? "search"} in ${entry.path}`
      : (entry.query ?? "search");
  }
  return entry.path ?? "files";
}

export function getExplorationEntrySearchText(
  parent: ExplorationParent,
  entry: ExplorationEntry,
): string {
  return Array.from(
    new Set(
      [
        getExplorationEntryDisplayLabel(parent, entry),
        getExplorationEntrySummaryText(entry),
        entry.path,
        entry.absolutePath,
        entry.name,
        entry.query,
        getExplorationEntryRangeText(entry),
      ].filter((part): part is string => Boolean(part?.trim())),
    ),
  ).join("\n");
}

export function estimateExplorationGroupHeightPx({
  detailRowCount,
  entryCount,
  expanded,
}: {
  detailRowCount: number;
  entryCount: number;
  expanded: boolean;
}): number {
  if (!expanded) return GROUP_HEADER_HEIGHT_PX;
  const rowCount = Math.max(0, entryCount) + Math.max(0, detailRowCount);
  const bodyHeight = Math.min(
    GROUP_BODY_MAX_HEIGHT_PX,
    GROUP_BODY_CHROME_PX +
      rowCount * GROUP_ROW_HEIGHT_PX +
      Math.max(0, rowCount - 1) * GROUP_ROW_GAP_PX,
  );
  return GROUP_HEADER_HEIGHT_PX + bodyHeight;
}
