import { useEffect, useRef, useState } from "react";
import { useCurrentSourceRuntime } from "../contexts/SourceRuntimeContext";
import { getSourceRuntimeRegistry } from "../lib/sourceRuntime";
import { toSourceTransportApiPath } from "../lib/sourceTransportPaths";

interface RemoteImageResult {
  /** URL to use for the image src (either direct path or blob URL) */
  url: string | null;
  /** Fetched blob, when the hook loaded the image through XHR/relay */
  blob?: Blob | null;
  /** Whether the image is currently loading */
  loading: boolean;
  /** Error message if loading failed */
  error: string | null;
}

/**
 * Hook for loading images that may need to be fetched via relay in remote mode.
 *
 * In remote mode (when connected through a relay like staging.yepanywhere.com),
 * direct HTTP requests to /api/... will 404 because the static site doesn't have
 * API endpoints. This hook fetches the image via the WebSocket relay and creates
 * a blob URL for display.
 *
 * In direct mode (localhost/LAN), it simply returns the original URL.
 *
 * @param apiPath - The API path for the image (e.g., "/api/projects/.../upload/image.png")
 * @returns Object with url, loading state, and error
 */
export function useRemoteImage(
  apiPath: string | null,
  enabled = true,
): RemoteImageResult {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Use ref to track blob URL for cleanup without triggering re-renders
  const blobUrlRef = useRef<string | null>(null);
  const transport = useCurrentSourceRuntime().transport;
  const sameOriginUrls = transport.capabilities.sameOriginUrls;

  // Fetch image through the transport when same-origin URLs cannot reach it.
  useEffect(() => {
    const revokeCurrentBlobUrl = () => {
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
    };

    if (!apiPath || !enabled) {
      revokeCurrentBlobUrl();
      setBlobUrl(null);
      setError(null);
      return;
    }

    if (sameOriginUrls) {
      revokeCurrentBlobUrl();
      setBlobUrl(null);
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    revokeCurrentBlobUrl();
    setBlobUrl(null);

    transport
      .fetchBlob(toSourceTransportApiPath(apiPath))
      .then((blob) => {
        if (cancelled) return;
        const url = URL.createObjectURL(blob);
        blobUrlRef.current = url;
        setBlobUrl(url);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error("[useRemoteImage] Failed to fetch image:", err);
        setError(err instanceof Error ? err.message : "Failed to load image");
        setLoading(false);
      });

    return () => {
      cancelled = true;
      revokeCurrentBlobUrl();
    };
  }, [apiPath, sameOriginUrls, enabled, transport]);

  // If same-origin URLs reach this source, the browser can use the path.
  if (!apiPath) {
    return { url: null, loading: false, error: null };
  }

  if (sameOriginUrls) {
    return { url: apiPath, loading: false, error: null };
  }

  return { url: blobUrl, loading, error };
}

/**
 * Hook that always fetches images via XHR and returns a blob URL.
 * Unlike useRemoteImage, this fetches in both direct and remote modes,
 * ensuring auth headers/cookies are included (important for endpoints
 * that require authentication like /api/local-image).
 */
export function useFetchedImage(
  apiPath: string | null,
  enabled = true,
): RemoteImageResult {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const blobUrlRef = useRef<string | null>(null);
  const transport = useCurrentSourceRuntime().transport;

  useEffect(() => {
    const revokeCurrentBlobUrl = () => {
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
    };

    if (!apiPath || !enabled) {
      revokeCurrentBlobUrl();
      setBlobUrl(null);
      setBlob(null);
      setError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    revokeCurrentBlobUrl();
    setBlobUrl(null);

    transport
      .fetchBlob(toSourceTransportApiPath(apiPath))
      .then((nextBlob) => {
        if (cancelled) return;
        const url = URL.createObjectURL(nextBlob);
        blobUrlRef.current = url;
        setBlob(nextBlob);
        setBlobUrl(url);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error("[useFetchedImage] Failed to fetch image:", err);
        setError(err instanceof Error ? err.message : "Failed to load image");
        setLoading(false);
      });

    return () => {
      cancelled = true;
      revokeCurrentBlobUrl();
    };
  }, [apiPath, enabled, transport]);

  if (!apiPath) {
    return { url: null, blob: null, loading: false, error: null };
  }

  return { url: blobUrl, blob, loading, error };
}

/**
 * Preload an image via relay and return its blob URL.
 * Useful for programmatic image loading outside of React components.
 *
 * @param apiPath - The API path for the image
 * @returns Promise resolving to blob URL, or the original path if not in remote mode
 */
export async function preloadRemoteImage(
  apiPath: string,
): Promise<string | null> {
  const transport =
    getSourceRuntimeRegistry().getCurrentSourceRuntime().transport;
  if (transport.capabilities.sameOriginUrls) {
    return apiPath;
  }

  const blob = await transport.fetchBlob(toSourceTransportApiPath(apiPath));
  return URL.createObjectURL(blob);
}
