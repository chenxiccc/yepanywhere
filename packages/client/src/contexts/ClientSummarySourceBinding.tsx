import { useLayoutEffect, useMemo } from "react";
import { useLocation } from "react-router-dom";
import {
  getCurrentClientSummarySourceKey,
  LOCAL_CLIENT_SUMMARY_SOURCE_KEY,
  REMOTE_NONE_CLIENT_SUMMARY_SOURCE_KEY,
  setCurrentClientSummarySourceKey,
  type ClientSummarySourceKey,
} from "../lib/clientSummaryStore";
import { getHostById, getHostByRelayUsername } from "../lib/hostStorage";
import {
  resolveSourceKeyForDirectUrl,
  resolveSourceKeyForSavedHost,
} from "../lib/sourceIdentity";
import {
  getSourceRuntimeRegistry,
  type SourceTransportRegistration,
} from "../lib/sourceRuntime";
import {
  getRelayUsernameFromRoute,
  isDirectAppRouteSegment,
} from "../lib/remoteRoutePaths";
import { useOptionalRemoteConnection } from "./RemoteConnectionContext";

const NON_HOST_ROUTE_SEGMENTS = new Set(["login", "remote", "share"]);

const LOCAL_TRANSPORT_REGISTRATION: SourceTransportRegistration = {
  kind: "localhost",
};
const SECURE_TRANSPORT_REGISTRATION: SourceTransportRegistration = {
  kind: "secure",
};

export interface ClientSummarySourceRemoteState {
  currentDirectUrl: string | null;
  currentHostId: string | null;
}

function firstPathSegment(pathname: string): string {
  const rawSegment = pathname.replace(/^\/+/, "").split("/")[0] ?? "";
  try {
    return decodeURIComponent(rawSegment);
  } catch {
    return rawSegment;
  }
}

export function resolveClientSummarySourceKey(options: {
  pathname: string;
  remote: ClientSummarySourceRemoteState | null;
}): ClientSummarySourceKey {
  const { pathname, remote } = options;
  if (!remote) {
    return LOCAL_CLIENT_SUMMARY_SOURCE_KEY;
  }

  const relayUsername = getRelayUsernameFromRoute(pathname);
  if (relayUsername) {
    const host = getHostByRelayUsername(relayUsername);
    return host
      ? resolveSourceKeyForSavedHost(host)
      : REMOTE_NONE_CLIENT_SUMMARY_SOURCE_KEY;
  }

  const segment = firstPathSegment(pathname);
  if (
    NON_HOST_ROUTE_SEGMENTS.has(segment) ||
    (segment !== "" && !isDirectAppRouteSegment(segment))
  ) {
    return REMOTE_NONE_CLIENT_SUMMARY_SOURCE_KEY;
  }

  const currentHost = remote.currentHostId
    ? getHostById(remote.currentHostId)
    : undefined;
  if (currentHost?.mode === "direct") {
    return resolveSourceKeyForSavedHost(currentHost);
  }

  if (remote.currentDirectUrl) {
    return resolveSourceKeyForDirectUrl(remote.currentDirectUrl);
  }

  return REMOTE_NONE_CLIENT_SUMMARY_SOURCE_KEY;
}

export function ClientSummarySourceBinding(): null {
  const remote = useOptionalRemoteConnection();
  const location = useLocation();
  const hasRemote = remote !== null;
  const currentDirectUrl = remote?.currentDirectUrl ?? null;
  const currentHostId = remote?.currentHostId ?? null;
  const sourceKey = useMemo(
    () =>
      resolveClientSummarySourceKey({
        pathname: location.pathname,
        remote: hasRemote
          ? {
              currentDirectUrl,
              currentHostId,
            }
          : null,
      }),
    [currentDirectUrl, currentHostId, hasRemote, location.pathname],
  );

  const transportRegistration = hasRemote
    ? SECURE_TRANSPORT_REGISTRATION
    : LOCAL_TRANSPORT_REGISTRATION;
  getSourceRuntimeRegistry().registerSourceTransport(
    sourceKey,
    transportRegistration,
  );
  if (getCurrentClientSummarySourceKey() !== sourceKey) {
    setCurrentClientSummarySourceKey(sourceKey);
  }

  useLayoutEffect(() => {
    getSourceRuntimeRegistry().registerSourceTransport(
      sourceKey,
      transportRegistration,
    );
    setCurrentClientSummarySourceKey(sourceKey);
  }, [sourceKey, transportRegistration]);

  return null;
}
