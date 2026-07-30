import { type ReactNode, useEffect } from "react";
import { useLocation } from "react-router-dom";
import { BottomOverscrollReload } from "./components/BottomOverscrollReload";
import { CacheMissBillingToasts } from "./components/CacheMissBillingToasts";
import { ClientLogRecordingBadge } from "./components/ClientLogRecordingBadge";
import { CodexUpdatePrompt } from "./components/CodexUpdatePrompt";
import { ConnectionBar } from "./components/ConnectionBar";
import { DesktopProviderNotice } from "./components/DesktopProviderNotice";
import { FloatingActionButton } from "./components/FloatingActionButton";
import { ReloadBanner, ReloadBannerStack } from "./components/ReloadBanner";
import { OnboardingWizard } from "./components/onboarding";
import { AuthProvider, useAuth } from "./contexts/AuthContext";
import { ClientSummarySourceBinding } from "./contexts/ClientSummarySourceBinding";
import {
  HostIdentityProvider,
  useHostIdentity,
} from "./contexts/HostIdentityContext";
import { InboxProvider } from "./contexts/InboxContext";
import { SchemaValidationProvider } from "./contexts/SchemaValidationContext";
import { CurrentSourceRuntimeProvider } from "./contexts/SourceRuntimeContext";
import { ToastProvider } from "./contexts/ToastContext";
import { useActivityBusConnection } from "./hooks/useActivityBusConnection";
import { useNeedsAttentionBadge } from "./hooks/useNeedsAttentionBadge";
import { useSyncNotifyInAppSetting } from "./hooks/useNotifyInApp";
import { useOnboarding } from "./hooks/useOnboarding";
import { primeProviderCache } from "./hooks/useProviders";
import {
  getVisibleReloadBanners,
  useReloadNotifications,
} from "./hooks/useReloadNotifications";
import { useSeedCompactThreshold } from "./hooks/useSeedCompactThreshold";
import { I18nProvider } from "./i18n";
import { useClientSummarySourceKey } from "./lib/clientSummaryStore";
import { initClientLogCollection } from "./lib/diagnostics";

interface Props {
  children: ReactNode;
}

/**
 * Inner component that uses hooks requiring InboxContext.
 */
function AppContent({ children }: Props) {
  const location = useLocation();
  const isSessionDetailRoute = /\/sessions\/[^/]+/.test(location.pathname);
  const { icon: hostIdentityIcon } = useHostIdentity();
  const { authEnabled, isAuthenticated, isLoading: authLoading } = useAuth();
  const sourceKey = useClientSummarySourceKey();

  // Manage SSE connection based on auth state (prevents 401s on login page)
  useActivityBusConnection();

  // Prime provider status and model catalogs during the first authenticated
  // tab visit, before a New Session surface needs them. The shared provider
  // cache deduplicates any consumer that mounts while this is still running.
  useEffect(() => {
    if (authLoading || (authEnabled && !isAuthenticated)) return;
    void primeProviderCache(sourceKey).catch(() => {
      // This background hint must not replace the consumer's normal retry and
      // error UI when provider discovery is temporarily unavailable.
    });
  }, [authEnabled, authLoading, isAuthenticated, sourceKey]);

  // Client-side log collection for connection diagnostics
  useEffect(() => initClientLogCollection(), []);

  // Sync notifyInApp setting to service worker on app startup and SW restarts
  useSyncNotifyInAppSetting();

  // Update tab title with needs-attention badge count (uses InboxContext)
  useNeedsAttentionBadge(hostIdentityIcon ?? undefined);

  // One-time seed of the per-model compact-early threshold for users migrating
  // from the pre-always-1M 200K window (task 029).
  useSeedCompactThreshold();

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
  const visibleReloads = getVisibleReloadBanners(
    !!isManualReloadMode,
    pendingReloads,
    { backendReloadSafetyKnown },
  );

  return (
    <>
      <ConnectionBar />
      <DesktopProviderNotice />
      <CacheMissBillingToasts />
      {!isSessionDetailRoute && <ClientLogRecordingBadge />}
      <ReloadBannerStack avoidSessionComposer={isSessionDetailRoute}>
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
      </ReloadBannerStack>
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
 * App wrapper that provides global functionality like reload notifications, toasts,
 * and schema validation.
 */
export function App({ children }: Props) {
  const { showWizard, isLoading, completeOnboarding } = useOnboarding();

  return (
    <I18nProvider>
      <ToastProvider>
        <AuthProvider>
          <ClientSummarySourceBinding />
          <CurrentSourceRuntimeProvider>
            <HostIdentityProvider>
              <InboxProvider>
                <SchemaValidationProvider>
                  <AppContent>{children}</AppContent>
                  {!isLoading && showWizard && (
                    <OnboardingWizard onComplete={completeOnboarding} />
                  )}
                  {!isLoading && !showWizard && <CodexUpdatePrompt />}
                </SchemaValidationProvider>
              </InboxProvider>
            </HostIdentityProvider>
          </CurrentSourceRuntimeProvider>
        </AuthProvider>
      </ToastProvider>
    </I18nProvider>
  );
}
