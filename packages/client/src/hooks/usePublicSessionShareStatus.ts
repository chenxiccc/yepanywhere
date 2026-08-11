import type {
  PublicShareStorageState,
  PublicSessionShareSessionStatusResponse,
} from "@yep-anywhere/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client";

const PUBLIC_SHARE_STATUS_POLL_MS = 5000;

interface UsePublicSessionShareStatusOptions {
  enabled: boolean;
  projectId: string;
  sessionId: string;
  storageState: PublicShareStorageState | undefined;
}

interface UsePublicSessionShareStatusResult {
  status: PublicSessionShareSessionStatusResponse | null;
  updateStatus: (next: PublicSessionShareSessionStatusResponse) => void;
}

function statusesEqual(
  current: PublicSessionShareSessionStatusResponse,
  next: PublicSessionShareSessionStatusResponse,
): boolean {
  return current === next || JSON.stringify(current) === JSON.stringify(next);
}

export function usePublicSessionShareStatus({
  enabled,
  projectId,
  sessionId,
  storageState,
}: UsePublicSessionShareStatusOptions): UsePublicSessionShareStatusResult {
  const [status, setStatus] =
    useState<PublicSessionShareSessionStatusResponse | null>(null);
  const statusRef = useRef<PublicSessionShareSessionStatusResponse | null>(
    null,
  );
  const updateStatus = useCallback(
    (next: PublicSessionShareSessionStatusResponse) => {
      const current = statusRef.current;
      if (current !== null && statusesEqual(current, next)) {
        return;
      }
      statusRef.current = next;
      setStatus(next);
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    statusRef.current = null;
    setStatus(null);

    if (!enabled || (storageState !== undefined && storageState !== "ready")) {
      return () => {
        cancelled = true;
      };
    }

    const refresh = async () => {
      try {
        const next = await api.getPublicSessionShareStatus(
          projectId,
          sessionId,
        );
        if (!cancelled) {
          updateStatus(next);
        }
      } catch {
        if (!cancelled) {
          statusRef.current = null;
          setStatus(null);
        }
      } finally {
        if (!cancelled) {
          timer = setTimeout(refresh, PUBLIC_SHARE_STATUS_POLL_MS);
        }
      }
    };

    void refresh();

    return () => {
      cancelled = true;
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [enabled, projectId, sessionId, storageState, updateStatus]);

  return { status, updateStatus };
}
