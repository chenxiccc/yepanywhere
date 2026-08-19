import {
  type HTMLAttributes,
  type ReactNode,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { TranslationFn } from "../i18n";
import styles from "./SourceFileOutline.module.css";
import { SourceFileStatusBadge } from "./SourceFileRow";

const FALLBACK_VISIBLE_ROWS = 14;
const ESTIMATED_ROW_HEIGHT = 29;

export interface SourceOutlineItem<T> {
  id: string;
  path: string;
  displayPath: string;
  statuses?: string[];
  value: T;
}

export interface SourceOutlinePathProps {
  "data-source-outline-id": string;
  "data-source-outline-path": string;
}

type SourceOutlineEntry<T> =
  | {
      kind: "file";
      item: SourceOutlineItem<T>;
      visiblePath: string;
      pathProps: SourceOutlinePathProps;
    }
  | {
      kind: "group";
      key: string;
      path: string;
      items: SourceOutlineItem<T>[];
      children: SourceOutlineEntry<T>[];
      statuses: string[];
    };

interface PathNode<T> {
  files: SourceOutlineItem<T>[];
  directories: Map<string, PathNode<T>>;
}

export function SourceFileSectionDivider({
  children,
  expanded,
  onToggle,
}: {
  children: ReactNode;
  expanded?: boolean;
  onToggle?: () => void;
}) {
  if (onToggle) {
    return (
      <button
        type="button"
        className={`${styles.sectionDivider} ${styles.sectionDividerButton}`}
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <span className={styles.sectionDisclosure} aria-hidden="true">
          {expanded ? "▾" : "▸"}
        </span>
        <span>{children}</span>
      </button>
    );
  }
  return (
    <div className={styles.sectionDivider}>
      <span>{children}</span>
    </div>
  );
}

/**
 * Shared path-compression outline for every Source Control file corpus. Paths
 * are grouped only after the caller has filtered and semantically partitioned
 * its files. The complete display path stays attached to each rendered row.
 */
export function SourceFileOutline<T>({
  items,
  scopeKey,
  query,
  className,
  renderFile,
  t,
  ...listProps
}: Omit<HTMLAttributes<HTMLUListElement>, "children"> & {
  items: SourceOutlineItem<T>[];
  scopeKey: string;
  query?: string;
  renderFile: (
    item: SourceOutlineItem<T>,
    visiblePath: string,
    pathProps: SourceOutlinePathProps,
  ) => ReactNode;
  t: TranslationFn;
}) {
  const listRef = useRef<HTMLUListElement>(null);
  const automaticExpansion = useRef(new Map<string, boolean>());
  const [explicitExpansion, setExplicitExpansion] = useState<
    Record<string, boolean>
  >({});
  const [availableRows, setAvailableRows] = useState(FALLBACK_VISIBLE_ROWS);
  const searching = (query?.trim().length ?? 0) > 0;
  const entries = useMemo(
    () =>
      searching
        ? items.map(
            (item): SourceOutlineEntry<T> => ({
              kind: "file",
              item,
              visiblePath: item.displayPath,
              pathProps: outlinePathProps(item),
            }),
          )
        : buildSourceOutline(items, scopeKey),
    [items, scopeKey, searching],
  );

  useLayoutEffect(() => {
    automaticExpansion.current.clear();
    setExplicitExpansion({});
  }, []);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const viewport = findScrollViewport(list);
    const measureHeight = () => {
      const height = viewport?.clientHeight ?? list.clientHeight;
      if (height > 0) {
        setAvailableRows(
          Math.max(1, Math.floor(height / ESTIMATED_ROW_HEIGHT)),
        );
      }
    };
    measureHeight();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measureHeight);
    observer.observe(viewport ?? list);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const groups = collectGroups(entries);
    if (groups.length === 0) return;
    const list = listRef.current;
    const measuredHeight = list
      ? (findScrollViewport(list)?.clientHeight ?? list.clientHeight)
      : 0;
    const rowBudget =
      measuredHeight > 0
        ? Math.max(1, Math.floor(measuredHeight / ESTIMATED_ROW_HEIGHT))
        : availableRows;
    let remainingRows = Math.max(0, rowBudget - entries.length);
    let changed = false;
    for (const group of groups) {
      if (automaticExpansion.current.has(group.key)) continue;
      const childRows = group.children.length;
      const expanded = childRows <= remainingRows;
      automaticExpansion.current.set(group.key, expanded);
      if (expanded) remainingRows -= childRows;
      changed = true;
    }
    if (changed) setExplicitExpansion((current) => ({ ...current }));
  }, [availableRows, entries]);

  return (
    <ul
      {...listProps}
      ref={listRef}
      className={[styles.outline, className].filter(Boolean).join(" ")}
    >
      {renderEntries(
        entries,
        explicitExpansion,
        automaticExpansion.current,
        (key, expanded) =>
          setExplicitExpansion((current) => ({
            ...current,
            [key]: !expanded,
          })),
        renderFile,
        t,
      )}
    </ul>
  );
}

function buildSourceOutline<T>(
  items: SourceOutlineItem<T>[],
  scopeKey: string,
): SourceOutlineEntry<T>[] {
  const root: PathNode<T> = { files: [], directories: new Map() };
  for (const item of items) {
    const segments = item.path.split("/").filter(Boolean);
    if (segments.length <= 1) {
      root.files.push(item);
      continue;
    }
    let node = root;
    for (const segment of segments.slice(0, -1)) {
      let child = node.directories.get(segment);
      if (!child) {
        child = { files: [], directories: new Map() };
        node.directories.set(segment, child);
      }
      node = child;
    }
    node.files.push(item);
  }
  return emitNode(root, "", scopeKey);
}

function emitNode<T>(
  node: PathNode<T>,
  prefix: string,
  scopeKey: string,
): SourceOutlineEntry<T>[] {
  const entries: SourceOutlineEntry<T>[] = node.files.map((item) => ({
    kind: "file",
    item,
    visiblePath: relativeDisplayPath(item, prefix),
    pathProps: outlinePathProps(item),
  }));
  for (const [segment, initialChild] of node.directories) {
    let child = initialChild;
    let groupPath = `${prefix}${segment}/`;
    while (child.files.length === 0 && child.directories.size === 1) {
      const next = child.directories.entries().next().value as
        | [string, PathNode<T>]
        | undefined;
      if (!next) break;
      groupPath += `${next[0]}/`;
      child = next[1];
    }
    const descendants = collectItems(child);
    entries.push({
      kind: "group",
      key: `${scopeKey}\0${groupPath}`,
      path: groupPath,
      items: descendants,
      children: emitNode(child, groupPath, scopeKey),
      statuses: collectStatuses(descendants),
    });
  }
  return entries;
}

function outlinePathProps<T>(
  item: SourceOutlineItem<T>,
): SourceOutlinePathProps {
  return {
    "data-source-outline-id": item.id,
    "data-source-outline-path": item.displayPath,
  };
}

function relativeDisplayPath<T>(item: SourceOutlineItem<T>, prefix: string) {
  if (!prefix) return item.displayPath;
  return item.displayPath
    .split(" → ")
    .map((part) => (part.startsWith(prefix) ? part.slice(prefix.length) : part))
    .join(" → ");
}

function collectItems<T>(node: PathNode<T>): SourceOutlineItem<T>[] {
  return [
    ...node.files,
    ...Array.from(node.directories.values()).flatMap(collectItems),
  ];
}

function collectStatuses<T>(items: SourceOutlineItem<T>[]) {
  const statuses: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    for (const status of item.statuses ?? []) {
      if (!seen.has(status)) {
        seen.add(status);
        statuses.push(status);
      }
    }
  }
  return statuses;
}

function collectGroups<T>(
  entries: SourceOutlineEntry<T>[],
): Array<Extract<SourceOutlineEntry<T>, { kind: "group" }>> {
  return entries.flatMap((entry) =>
    entry.kind === "group" ? [entry, ...collectGroups(entry.children)] : [],
  );
}

function renderEntries<T>(
  entries: SourceOutlineEntry<T>[],
  explicitExpansion: Record<string, boolean>,
  automaticExpansion: ReadonlyMap<string, boolean>,
  toggle: (key: string, expanded: boolean) => void,
  renderFile: (
    item: SourceOutlineItem<T>,
    visiblePath: string,
    pathProps: SourceOutlinePathProps,
  ) => ReactNode,
  t: TranslationFn,
): ReactNode[] {
  return entries.map((entry) => {
    if (entry.kind === "file") {
      return renderFile(entry.item, entry.visiblePath, entry.pathProps);
    }
    const expanded =
      explicitExpansion[entry.key] ??
      automaticExpansion.get(entry.key) ??
      false;
    const label = t(
      expanded ? "sourceCollapsePathGroup" : "sourceExpandPathGroup",
      { path: entry.path, count: entry.items.length },
    );
    return (
      <li key={entry.key} className={styles.group}>
        <button
          type="button"
          className={styles.groupButton}
          data-source-list-item
          aria-expanded={expanded}
          aria-label={label}
          title={label}
          onClick={() => toggle(entry.key, expanded)}
        >
          <span className={styles.disclosure} aria-hidden="true">
            {expanded ? "▾" : "▸"}
          </span>
          <span className={styles.groupLabel}>{entry.path}</span>
          {entry.statuses.length > 0 && (
            <span className={styles.groupStatuses}>
              {entry.statuses.map((status) => (
                <SourceFileStatusBadge key={status} status={status} t={t} />
              ))}
            </span>
          )}
          <span className={styles.groupCount}>{entry.items.length}</span>
        </button>
        {expanded && (
          <ul className={styles.children}>
            {renderEntries(
              entry.children,
              explicitExpansion,
              automaticExpansion,
              toggle,
              renderFile,
              t,
            )}
          </ul>
        )}
      </li>
    );
  });
}

function findScrollViewport(element: HTMLElement): HTMLElement | null {
  let current = element.parentElement;
  while (current) {
    const overflowY = getComputedStyle(current).overflowY;
    if (overflowY === "auto" || overflowY === "scroll") return current;
    current = current.parentElement;
  }
  return element.parentElement;
}
