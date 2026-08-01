const BTW_TITLE_PREFIX = /^\/btw(?:\s+|$)/i;

export function isBtwAsideSessionTitle(
  title: string | null | undefined,
): boolean {
  return BTW_TITLE_PREFIX.test(title?.trimStart() ?? "");
}

/**
 * Positive `/btw` identity. New servers persist parentSessionKind; older
 * servers fall back to the established generated title instead of treating
 * every provider fork lineage as an aside.
 */
export function isBtwAsideSession(options: {
  parentSessionId?: string | null;
  parentSessionKind?: "btw-aside" | null;
  title?: string | null;
  fullTitle?: string | null;
}): boolean {
  return (
    options.parentSessionKind === "btw-aside" ||
    (!!options.parentSessionId &&
      (isBtwAsideSessionTitle(options.title) ||
        isBtwAsideSessionTitle(options.fullTitle)))
  );
}

export function getBtwAsideSessionDisplayTitle(title: string): string {
  const withoutPrefix = title.trimStart().replace(BTW_TITLE_PREFIX, "").trim();
  return withoutPrefix || "Aside";
}

export function buildBtwAsideParentHref(
  basePath: string,
  projectId: string,
  parentSessionId: string,
  asideSessionId: string,
): string {
  const normalizedBasePath = basePath.endsWith("/")
    ? basePath.slice(0, -1)
    : basePath;
  const params = new URLSearchParams({ btw: asideSessionId });
  return `${normalizedBasePath}/projects/${projectId}/sessions/${parentSessionId}?${params.toString()}`;
}
