/**
 * Remote client entry point.
 *
 * This is a separate entry point for the remote (static) client that:
 * - Uses SecureConnection for all communication (SRP + NaCl encryption)
 * - Shows a login page before connecting
 * - Does NOT use cookie-based auth (uses SRP instead)
 *
 * Route structure:
 * - UnauthenticatedGate: wraps login routes, redirects to app if already connected
 * - ConnectionGate: wraps direct-mode app routes (no relay username in URL)
 * - RelayConnectionGate: wraps relay-mode app routes (/-/relay/:relayUsername/...)
 *
 * ConnectionGate and RelayConnectionGate share the same APP_ROUTES.
 * This avoids duplicating route definitions or provider wrapping.
 */

console.log("[RemoteClient] Loading remote-main.tsx entry point");

import { Fragment, lazy, StrictMode } from "react";
import { createRoot } from "react-dom/client";

// Toggle to disable StrictMode for easier debugging (avoids double renders)
const STRICT_MODE = false;
const Wrapper = STRICT_MODE ? StrictMode : Fragment;

import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { RouteModule, routeModule } from "./components/RouteModule";
import { TooltipLayer } from "./components/ui/TooltipLayer";
import { initializeContentMaxWidth } from "./hooks/useContentMaxWidth";
import { initializeFontSize } from "./hooks/useFontSize";
import { initializeSidebarSpacing } from "./hooks/useSidebarSpacing";
import { initializeOutputAppearance } from "./hooks/useOutputAppearance";
import { initializeTabSize } from "./hooks/useTabSize";
import { initializeTheme } from "./hooks/useTheme";
import { initializeTooltipAppearance } from "./hooks/useTooltipAppearance";
import { I18nProvider } from "./i18n";
import "./styles/index.css";

const ConnectionGate = lazy(() =>
  import("./RemoteApp").then(({ ConnectionGate }) => ({
    default: ConnectionGate,
  })),
);
const RemoteApp = lazy(() =>
  import("./RemoteApp").then(({ RemoteApp }) => ({ default: RemoteApp })),
);
const UnauthenticatedGate = lazy(() =>
  import("./RemoteApp").then(({ UnauthenticatedGate }) => ({
    default: UnauthenticatedGate,
  })),
);
const NavigationLayout = lazy(() =>
  import("./layouts").then(({ NavigationLayout }) => ({
    default: NavigationLayout,
  })),
);
const SessionDomLingerRouteMarker = lazy(() =>
  import("./layouts").then(({ SessionDomLingerRouteMarker }) => ({
    default: SessionDomLingerRouteMarker,
  })),
);

const ActivityPage = lazy(() =>
  import("./pages/ActivityPage").then(({ ActivityPage }) => ({
    default: ActivityPage,
  })),
);
const AgentsPage = lazy(() =>
  import("./pages/AgentsPage").then(({ AgentsPage }) => ({
    default: AgentsPage,
  })),
);
const BangCommandsPage = lazy(() =>
  import("./pages/BangCommandsPage").then(({ BangCommandsPage }) => ({
    default: BangCommandsPage,
  })),
);
const DirectLoginPage = lazy(() =>
  import("./pages/DirectLoginPage").then(({ DirectLoginPage }) => ({
    default: DirectLoginPage,
  })),
);
const EmulatorPage = lazy(() =>
  import("./pages/EmulatorPage").then(({ EmulatorPage }) => ({
    default: EmulatorPage,
  })),
);
const FilePage = lazy(() =>
  import("./pages/FilePage").then(({ FilePage }) => ({ default: FilePage })),
);
const GitStatusPage = lazy(() =>
  import("./pages/GitStatusPage").then(({ GitStatusPage }) => ({
    default: GitStatusPage,
  })),
);
const GlobalSessionsPage = lazy(() =>
  import("./pages/GlobalSessionsPage").then(({ GlobalSessionsPage }) => ({
    default: GlobalSessionsPage,
  })),
);
const HostPickerPage = lazy(() =>
  import("./pages/HostPickerPage").then(({ HostPickerPage }) => ({
    default: HostPickerPage,
  })),
);
const HostsRoute = lazy(() =>
  import("./pages/HostsPage").then(({ HostsRoute }) => ({
    default: HostsRoute,
  })),
);
const InboxPage = lazy(() =>
  import("./pages/InboxPage").then(({ InboxPage }) => ({
    default: InboxPage,
  })),
);
const LegacyRelayRouteRedirect = lazy(() =>
  import("./pages/LegacyRelayRouteRedirect").then(
    ({ LegacyRelayRouteRedirect }) => ({
      default: LegacyRelayRouteRedirect,
    }),
  ),
);
const MultiHostMonitorPage = lazy(() =>
  import("./pages/MultiHostMonitorPage").then(({ MultiHostMonitorPage }) => ({
    default: MultiHostMonitorPage,
  })),
);
const ProjectSessionsRedirect = lazy(() =>
  import("./pages/ProjectSessionsRedirect").then(
    ({ ProjectSessionsRedirect }) => ({
      default: ProjectSessionsRedirect,
    }),
  ),
);
const NewSessionPage = lazy(() =>
  import("./pages/NewSessionPage").then(({ NewSessionPage }) => ({
    default: NewSessionPage,
  })),
);
const ProjectsPage = lazy(() =>
  import("./pages/ProjectsPage").then(({ ProjectsPage }) => ({
    default: ProjectsPage,
  })),
);
const PublicShareFilePage = lazy(() =>
  import("./pages/PublicShareFilePage").then(({ PublicShareFilePage }) => ({
    default: PublicShareFilePage,
  })),
);
const PublicSharePage = lazy(() =>
  import("./pages/PublicSharePage").then(({ PublicSharePage }) => ({
    default: PublicSharePage,
  })),
);
const RelayConnectionGate = lazy(() =>
  import("./pages/RelayConnectionGate").then(({ RelayConnectionGate }) => ({
    default: RelayConnectionGate,
  })),
);
const RelayLoginPage = lazy(() =>
  import("./pages/RelayLoginPage").then(({ RelayLoginPage }) => ({
    default: RelayLoginPage,
  })),
);
const SessionPage = lazy(() =>
  import("./pages/SessionPage").then(({ SessionPage }) => ({
    default: SessionPage,
  })),
);
const SettingsLayout = lazy(() =>
  import("./pages/settings").then(({ SettingsLayout }) => ({
    default: SettingsLayout,
  })),
);
const WorkstreamsPage = lazy(() =>
  import("./pages/WorkstreamsPage").then(({ WorkstreamsPage }) => ({
    default: WorkstreamsPage,
  })),
);

// Apply saved preferences before React renders to avoid flash
initializeTheme();
initializeFontSize();
initializeSidebarSpacing();
initializeOutputAppearance();
initializeTabSize();
initializeContentMaxWidth();
initializeTooltipAppearance();

// Register SW at startup so PWA install is available without visiting settings
void import("./lib/registerServiceWorker").then(
  ({ registerServiceWorkerAtStartup }) => registerServiceWorkerAtStartup(),
);

// Get base URL for router (Vite sets this based on --base flag)
// Remove trailing slash for BrowserRouter basename
const basename = import.meta.env.BASE_URL.replace(/\/$/, "") || undefined;

/**
 * Shared app routes used by both direct mode (ConnectionGate) and
 * relay mode (RelayConnectionGate). Uses relative paths so they resolve
 * correctly under both "/" and "/-/relay/:relayUsername/".
 */
const APP_ROUTES = (
  <>
    <Route index element={<Navigate to="projects" replace />} />

    {/* IMPORTANT: Keep routes in sync with main.tsx — adding a route here? Add it there too! */}
    <Route
      element={
        <RouteModule>
          <NavigationLayout
            sessionElement={(route, { parked }) => (
              <RouteModule key={route.key}>
                <SessionPage
                  projectId={route.projectId}
                  sessionId={route.sessionId}
                  routeLocation={route.location}
                  isDomLingerParked={parked}
                />
              </RouteModule>
            )}
          />
        </RouteModule>
      }
    >
      <Route path="projects" element={routeModule(<ProjectsPage />)} />
      <Route
        path="projects/:projectId/workstreams"
        element={routeModule(<WorkstreamsPage />)}
      />
      <Route
        path="projects/:projectId"
        element={routeModule(<ProjectSessionsRedirect />)}
      />
      <Route path="sessions" element={routeModule(<GlobalSessionsPage />)} />
      <Route path="agents" element={routeModule(<AgentsPage />)} />
      <Route path="inbox" element={routeModule(<InboxPage />)} />
      <Route path="-/hosts" element={routeModule(<HostsRoute />)} />
      <Route path="git-status" element={routeModule(<GitStatusPage />)} />
      <Route path="bang-commands" element={routeModule(<BangCommandsPage />)} />
      <Route path="devices" element={routeModule(<EmulatorPage />)} />
      <Route path="devices/:deviceId" element={routeModule(<EmulatorPage />)} />
      <Route path="settings" element={routeModule(<SettingsLayout />)} />
      <Route
        path="settings/:category"
        element={routeModule(<SettingsLayout />)}
      />
      <Route path="new-session" element={routeModule(<NewSessionPage />)} />
      <Route
        path="projects/:projectId/file"
        element={routeModule(<FilePage />)}
      />
      <Route
        path="projects/:projectId/sessions/:sessionId"
        element={routeModule(<SessionDomLingerRouteMarker />)}
      />
    </Route>

    {/* Pages with custom layouts */}
    <Route path="activity" element={routeModule(<ActivityPage />)} />

    {/* Catch-all redirect to projects (must use ../ to escape splat route's relative resolution) */}
    <Route path="*" element={<Navigate to="../projects" replace />} />
  </>
);

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element not found");
}

createRoot(rootElement).render(
  <Wrapper>
    <TooltipLayer />
    <BrowserRouter basename={basename}>
      <I18nProvider>
        <Routes>
          <Route
            path="/share/:secret/file"
            element={routeModule(<PublicShareFilePage />)}
          />
          <Route
            path="/share/:secret"
            element={routeModule(<PublicSharePage />)}
          />
          <Route
            path="/remote/share/:secret/file"
            element={routeModule(<PublicShareFilePage />)}
          />
          <Route
            path="/remote/share/:secret"
            element={routeModule(<PublicSharePage />)}
          />
          <Route
            path="/-/monitor"
            element={routeModule(<MultiHostMonitorPage />)}
          />
          <Route
            path="*"
            element={
              <RouteModule>
                <RemoteApp>
                  <Routes>
                    {/* Login routes — redirect to app if already connected */}
                    <Route element={routeModule(<UnauthenticatedGate />)}>
                      <Route
                        path="/login"
                        element={routeModule(<HostPickerPage />)}
                      />
                      <Route
                        path="/login/direct"
                        element={routeModule(<DirectLoginPage />)}
                      />
                      <Route
                        path="/login/relay"
                        element={routeModule(<RelayLoginPage />)}
                      />
                    </Route>

                    {/* Direct mode — requires connection, no relay username in URL */}
                    <Route element={routeModule(<ConnectionGate />)}>
                      {APP_ROUTES}
                    </Route>

                    {/* Canonical relay routes live under a reserved namespace. */}
                    <Route
                      path="/-/relay/:relayUsername"
                      element={routeModule(<RelayConnectionGate />)}
                    >
                      {APP_ROUTES}
                    </Route>

                    {/* Old username-at-root links redirect only when unambiguous. */}
                    <Route
                      path="/:legacyRelayUsername/*"
                      element={routeModule(<LegacyRelayRouteRedirect />)}
                    />
                  </Routes>
                </RemoteApp>
              </RouteModule>
            }
          />
        </Routes>
      </I18nProvider>
    </BrowserRouter>
  </Wrapper>,
);
