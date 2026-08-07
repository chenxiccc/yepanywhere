function routerBasename(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

/**
 * Convert a React Router app path into a browser URL for raw href/window.open.
 * React Router adds basename for <Link>/navigate, but raw browser APIs do not.
 */
export function toBrowserAppHref(
  routerPath: string,
  baseUrl = import.meta.env.BASE_URL,
): string {
  const path = routerPath.startsWith("/") ? routerPath : `/${routerPath}`;
  return `${routerBasename(baseUrl)}${path}`;
}

/** Convert an asset relative to Vite's application base into a browser URL. */
export function toBrowserAssetHref(
  assetPath: string,
  baseUrl = import.meta.env.BASE_URL,
): string {
  return `${routerBasename(baseUrl)}/${assetPath.replace(/^\/+/, "")}`;
}

export function isBrowserAppRoutePath(
  pathname: string,
  routerPath: string,
  baseUrl = import.meta.env.BASE_URL,
): boolean {
  const browserPath = toBrowserAppHref(routerPath, baseUrl);
  return pathname === browserPath || pathname.startsWith(`${browserPath}/`);
}
