export const FRONTEND_RELOAD_QUERY_PARAM = "__ya_reload";

function toReloadUrl(currentUrl: string | URL): URL {
  return new URL(
    typeof currentUrl === "string" ? currentUrl : currentUrl.toString(),
  );
}

export function buildFrontendReloadUrl(
  currentUrl: string | URL,
  reloadToken: string,
): string {
  const url = toReloadUrl(currentUrl);
  url.searchParams.set(FRONTEND_RELOAD_QUERY_PARAM, reloadToken);
  return url.toString();
}

export function getFrontendReloadCleanupUrl(
  currentUrl: string | URL,
): string | null {
  const url = toReloadUrl(currentUrl);
  if (!url.searchParams.has(FRONTEND_RELOAD_QUERY_PARAM)) {
    return null;
  }
  url.searchParams.delete(FRONTEND_RELOAD_QUERY_PARAM);
  return url.toString();
}
