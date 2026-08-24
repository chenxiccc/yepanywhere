import { useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  acknowledgeIncomingShare,
  INCOMING_SHARE_QUERY_PARAM,
  readIncomingShare,
} from "../lib/incomingShare";

interface IncomingShareOptions {
  enabled?: boolean;
  onError?: (error: Error) => void;
}

/** Consume a PWA image share only after its destination accepts the files. */
export function useIncomingShareFiles(
  onFiles: (files: File[]) => void | Promise<void>,
  options: IncomingShareOptions = {},
): void {
  const { enabled = true, onError } = options;
  const location = useLocation();
  const navigate = useNavigate();
  const onFilesRef = useRef(onFiles);
  const onErrorRef = useRef(onError);
  const claimedIdRef = useRef<string | null>(null);
  onFilesRef.current = onFiles;
  onErrorRef.current = onError;

  const params = new URLSearchParams(location.search);
  const shareId = params.get(INCOMING_SHARE_QUERY_PARAM);

  useEffect(() => {
    if (!enabled || !shareId || claimedIdRef.current === shareId) return;
    claimedIdRef.current = shareId;
    let mounted = true;

    const removeShareParam = () => {
      const nextParams = new URLSearchParams(location.search);
      nextParams.delete(INCOMING_SHARE_QUERY_PARAM);
      const search = nextParams.toString();
      navigate(
        {
          pathname: location.pathname,
          search: search ? `?${search}` : "",
          hash: location.hash,
        },
        { replace: true, state: location.state },
      );
    };

    void (async () => {
      try {
        const files = await readIncomingShare(shareId);
        if (!mounted) return;
        if (files.length === 0) {
          throw new Error("The shared image is no longer available");
        }
        await onFilesRef.current(files);
        if (!mounted) return;
        await acknowledgeIncomingShare(shareId);
        if (mounted) removeShareParam();
      } catch (reason: unknown) {
        if (!mounted) return;
        const error =
          reason instanceof Error
            ? reason
            : new Error("The shared image could not be attached");
        onErrorRef.current?.(error);
        removeShareParam();
      }
    })();

    return () => {
      mounted = false;
    };
  }, [
    enabled,
    location.hash,
    location.pathname,
    location.search,
    location.state,
    navigate,
    shareId,
  ]);
}
