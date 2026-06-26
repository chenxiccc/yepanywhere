/**
 * RemoteApp - Wrapper for remote client mode.
 *
 * This replaces the regular App wrapper for the remote (static) client.
 * Key differences:
 * - No AuthProvider (SRP handles authentication)
 * - Shows login pages when not connected (handled via routing)
 * - Uses RemoteConnectionProvider for connection state
 *
 * Architecture:
 * RemoteApp provides all shared providers (Toast, RemoteConnection, Inbox, SchemaValidation).
 * Route-level gating is handled by layout routes in remote-main.tsx:
 * - UnauthenticatedGate: wraps login routes, redirects to app if already connected
 * - ConnectionGate: wraps direct-mode app routes, requires connection
 * - RelayConnectionGate: wraps relay-mode app routes, manages relay connection
 * Both ConnectionGate and RelayConnectionGate render ConnectedAppContent when connected.
 */

import { type ReactNode, useEffect } from "react";
import { Navigate, Outlet, useLocation } from "react-router-dom";
import { BottomOverscrollReload } from "./components/BottomOverscrollReload";
import { ClientLogRecordingBadge } from "./components/ClientLogRecordingBadge";
import { ConnectionBar } from "./components/ConnectionBar";
import { FloatingActionButton } from "./components/FloatingActionButton";
import { HostOfflineModal } from "./components/HostOfflineModal";
import { ReloadBanner } from "./components/ReloadBanner";
import { RemoteCompatibilityNotices } from "./components/RemoteCompatibilityNotices";
import { ClientSummarySourceBinding } from "./contexts/ClientSummarySourceBinding";
import { InboxProvider } from "./contexts/InboxContext";
import {
  RemoteConnectionProvider,
  useRemoteConnection,
} from "./contexts/RemoteConnectionContext";
import { SchemaValidationProvider } from "./contexts/SchemaValidationContext";
import { CurrentSourceRuntimeProvider } from "./contexts/SourceRuntimeContext";
import { ToastProvider } from "./contexts/ToastContext";
import { useNeedsAttentionBadge } from "./hooks/useNeedsAttentionBadge";
import {
  useSyncActiveSessionId,
  useSyncNotifyInAppSetting,
} from "./hooks/useNotifyInApp";
import {
  getVisibleReloadBanners,
  useReloadNotifications,
} from "./hooks/useReloadNotifications";
import { useActivityBusState } from "./hooks/useActivityBusState";
import { useRemoteActivityBusConnection } from "./hooks/useRemoteActivityBusConnection";
import { useRemoteBasePath } from "./hooks/useRemoteBasePath";
import { useVersion } from "./hooks/useVersion";
import { initClientLogCollection } from "./lib/diagnostics";
import {
  getRelayCanonicalRedirectTarget,
  getSafeRemoteReturnTarget,
} from "./lib/remoteRoutePaths";

interface Props {
  children: ReactNode;
}

/**
 * Wrapper for connected app content. Runs hooks that require an active
 * SecureConnection. Used by both ConnectionGate (direct mode) and
 * RelayConnectionGate (relay mode) once connected.
 */
export function ConnectedAppContent({ children }: { children: ReactNode }) {
  const location = useLocation();
  useRemoteActivityBusConnection();
  const { currentRelayUsername } = useRemoteConnection();
  const { version: versionInfo } = useVersion();

  const {
    isManualReloadMode,
    pendingReloads,
    reloadBackend,
    reloadFrontend,
    scheduleSafeRestart,
    cancelSafeRestart,
    dismiss,
    unsafeToRestart,
    interruptibleSessionCount,
    queuedSessionMessageCount,
    safeRestartState,
    safeRestartMutating,
    backendReloadSafetyKnown,
  } = useReloadNotifications();
  const isSessionDetailRoute = /\/sessions\/[^/]+/.test(location.pathname);
  const visibleReloads = getVisibleReloadBanners(
    !!isManualReloadMode,
    pendingReloads,
    { backendReloadSafetyKnown },
  );

  return (
    <>
      <RemoteCompatibilityNotices
        versionInfo={versionInfo}
        relayUsername={currentRelayUsername}
      />
      {visibleReloads.backend && (
        <ReloadBanner
          target="backend"
          onReload={reloadBackend}
          onDismiss={() => dismiss("backend")}
          onRestartWhenSafe={scheduleSafeRestart}
          onCancelSafeRestart={cancelSafeRestart}
          unsafeToRestart={unsafeToRestart}
          interruptibleSessionCount={interruptibleSessionCount}
          queuedSessionMessageCount={queuedSessionMessageCount}
          safeRestartState={safeRestartState}
          safeRestartMutating={safeRestartMutating}
        />
      )}
      {visibleReloads.frontend && (
        <ReloadBanner
          target="frontend"
          onReload={reloadFrontend}
          onDismiss={() => dismiss("frontend")}
        />
      )}
      <BottomOverscrollReload
        disabled={isSessionDetailRoute}
        onReload={reloadFrontend}
      />
      {children}
      <FloatingActionButton />
    </>
  );
}

/**
 * Layout route that redirects away from login pages if already connected.
 * Renders <Outlet /> (login pages) when not connected.
 */
export function UnauthenticatedGate() {
  const { connection, currentRelayUsername, isIntentionalDisconnect } =
    useRemoteConnection();
  const basePath = useRemoteBasePath();
  const location = useLocation();

  const loginParams = new URLSearchParams(location.search);
  const returnTo = loginParams.get("returnTo");
  const safeReturnTo = getSafeRemoteReturnTarget(
    returnTo,
    currentRelayUsername,
  );

  // If connected and user didn't intentionally disconnect, redirect to app
  if (connection && !isIntentionalDisconnect) {
    return <Navigate to={safeReturnTo ?? `${basePath}/projects`} replace />;
  }

  return <Outlet />;
}

/**
 * Layout route for direct-mode app routes. Requires an active connection.
 *
 * - Reconnecting: stay on current page (don't redirect to /login)
 * - Auto-resuming: show loading spinner
 * - Not connected + auto-resume error: show HostOfflineModal
 * - Not connected: redirect to /login
 * - Connected: render ConnectedAppContent + child routes
 */
export function ConnectionGate() {
  const {
    connection,
    currentRelayUsername,
    isAutoResuming,
    autoResumeError,
    clearAutoResumeError,
    retryAutoResume,
  } = useRemoteConnection();
  const { connectionState } = useActivityBusState();
  const location = useLocation();
  const returnTo = `${location.pathname}${location.search}${location.hash}`;
  const relayCanonicalTarget = getRelayCanonicalRedirectTarget(
    location,
    currentRelayUsername,
  );

  // During auto-resume, don't redirect - show loading state
  // This preserves the current URL so we stay on the same page after successful resume
  if (isAutoResuming) {
    return (
      <div className="auto-resume-loading">
        <div className="loading-spinner" />
        <p>Reconnecting...</p>
      </div>
    );
  }

  if (connection && relayCanonicalTarget) {
    return <Navigate to={relayCanonicalTarget} replace />;
  }

  // During reconnection, stay on the current page — don't redirect to /login.
  // SourceTransportStatus is the source of truth; React connection state may be stale.
  if (connectionState === "reconnecting") {
    return <Outlet />;
  }

  // Not connected (and not auto-resuming)
  if (!connection) {
    // If auto-resume failed with a connection error, show the modal
    if (autoResumeError) {
      return (
        <HostOfflineModal
          error={autoResumeError}
          onRetry={retryAutoResume}
          onGoToLogin={clearAutoResumeError}
        />
      );
    }

    return (
      <Navigate
        to={`/login?returnTo=${encodeURIComponent(returnTo)}`}
        replace
      />
    );
  }

  // Connected - render child routes with connected-state hooks
  return (
    <ConnectedAppContent>
      <Outlet />
    </ConnectedAppContent>
  );
}

/**
 * Inner component that runs hooks requiring InboxContext.
 * Must be rendered inside InboxProvider.
 */
function RemoteAppInner({ children }: Props) {
  const location = useLocation();
  const isSessionDetailRoute = /\/sessions\/[^/]+/.test(location.pathname);

  useNeedsAttentionBadge();

  // Sync the currently-viewed session id to the SW so push notifications can
  // suppress the session the user is already looking at. Mirrors App.tsx so
  // the relay/remote entry is covered (the SW cannot read the SPA route).
  // 把当前正在查看的 session id 同步给 SW，使推送能抑制用户正在看的会话。
  // 与 App.tsx 对齐，覆盖 relay/remote 入口（SW 读不到 SPA 路由）。
  useSyncActiveSessionId();

  return (
    <>
      <ConnectionBar />
      {!isSessionDetailRoute && <ClientLogRecordingBadge />}
      {children}
    </>
  );
}

/**
 * RemoteApp wrapper for remote client mode.
 *
 * Provides shared context for all routes:
 * - ToastProvider (always available)
 * - RemoteConnectionProvider for connection management
 * - InboxProvider for inbox data (works without connection — gracefully empty)
 * - SchemaValidationProvider (localStorage only, no connection needed)
 * - Connection-independent hooks (notify sync, log collection)
 */
export function RemoteApp({ children }: Props) {
  useEffect(() => initClientLogCollection(), []);
  useSyncNotifyInAppSetting();

  return (
    <ToastProvider>
      <RemoteConnectionProvider>
        <ClientSummarySourceBinding />
        <CurrentSourceRuntimeProvider>
          <InboxProvider>
            <SchemaValidationProvider>
              <RemoteAppInner>{children}</RemoteAppInner>
            </SchemaValidationProvider>
          </InboxProvider>
        </CurrentSourceRuntimeProvider>
      </RemoteConnectionProvider>
    </ToastProvider>
  );
}
