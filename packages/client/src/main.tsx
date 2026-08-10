import { Fragment, lazy, StrictMode } from "react";
import { createRoot } from "react-dom/client";

// Toggle to disable StrictMode for easier debugging (avoids double renders)
const STRICT_MODE = false;
const Wrapper = STRICT_MODE ? StrictMode : Fragment;
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { RouteModule, routeModule } from "./components/RouteModule";
import { TooltipLayer } from "./components/ui/TooltipLayer";
import { initializeFontSize } from "./hooks/useFontSize";
import { initializeSidebarSpacing } from "./hooks/useSidebarSpacing";
import { initializeContentMaxWidth } from "./hooks/useContentMaxWidth";
import { initializeOutputAppearance } from "./hooks/useOutputAppearance";
import { initializeTabSize } from "./hooks/useTabSize";
import { initializeTheme } from "./hooks/useTheme";
import { initializeTooltipAppearance } from "./hooks/useTooltipAppearance";
import { I18nProvider } from "./i18n";
import "./styles/index.css";

const App = lazy(() => import("./App").then(({ App }) => ({ default: App })));
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
const LoginPage = lazy(() =>
  import("./pages/LoginPage").then(({ LoginPage }) => ({
    default: LoginPage,
  })),
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

/**
 * Dev-only notice shown when the app is loaded directly from the Vite dev port
 * instead of through the main server. Rendered before theme init, so it uses
 * self-contained inline styles rather than relying on app CSS variables.
 */
function WrongPortNotice({ backendUrl }: { backendUrl: string }) {
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        boxSizing: "border-box",
        fontFamily: "system-ui, -apple-system, sans-serif",
        background: "#0f1115",
        color: "#e6e6e6",
      }}
    >
      <div
        style={{
          maxWidth: 460,
          width: "100%",
          border: "1px solid #2a2f3a",
          borderRadius: 12,
          padding: "28px 28px 24px",
          background: "#161a22",
          boxShadow: "0 8px 30px rgba(0,0,0,0.35)",
        }}
      >
        <div
          style={{
            fontSize: 12,
            fontWeight: 600,
            letterSpacing: 0.4,
            color: "#8aa0ff",
            textTransform: "uppercase",
            marginBottom: 10,
          }}
        >
          Wrong port
        </div>
        <h1 style={{ fontSize: 20, fontWeight: 650, margin: "0 0 10px" }}>
          This is the Vite dev server, not the app
        </h1>
        <p
          style={{
            fontSize: 14,
            lineHeight: 1.55,
            margin: "0 0 20px",
            color: "#b6bcc8",
          }}
        >
          You've hit the internal HMR / asset server on port {__VITE_DEV_PORT__}
          , which has no backend. The Yep Anywhere UI runs on the main server —
          open the link below instead.
        </p>
        <a
          href={backendUrl}
          style={{
            display: "inline-block",
            padding: "10px 16px",
            borderRadius: 8,
            background: "#3b6cf6",
            color: "#fff",
            fontSize: 14,
            fontWeight: 600,
            textDecoration: "none",
          }}
        >
          Open Yep Anywhere →
        </a>
        <div
          style={{
            marginTop: 14,
            fontSize: 12.5,
            color: "#7a8290",
            wordBreak: "break-all",
          }}
        >
          {backendUrl}
        </div>
      </div>
    </div>
  );
}

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element not found");
}

// Direct access to the Vite dev server port (e.g. localhost:3402) serves the SPA
// shell but has no backend/API — the first /api fetch returns index.html and the
// app dies with a confusing "Unexpected token '<'" JSON error. The main server
// (port 3400) proxies to Vite, so when accessed correctly window.location.port is
// the backend port, not the Vite port. Detect the wrong-port case and show a
// pointer to the real app instead. Stripped from production via import.meta.env.DEV.
if (import.meta.env.DEV && window.location.port === String(__VITE_DEV_PORT__)) {
  const backendUrl = `${window.location.protocol}//${window.location.hostname}:${__BACKEND_PORT__}${window.location.pathname}${window.location.search}${window.location.hash}`;
  createRoot(rootElement).render(<WrongPortNotice backendUrl={backendUrl} />);
} else {
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

  if (import.meta.env.VITE_E2E_SOURCE_TRANSPORT_SMOKE === "true") {
    void import("./lib/e2e/sourceTransportCoexistenceSmoke").then(
      ({ installSourceTransportCoexistenceSmoke }) => {
        installSourceTransportCoexistenceSmoke();
      },
    );
  }

  // SSE activity stream connection is managed by useActivityBusConnection hook
  // in App.tsx, which connects only when authenticated (or auth is disabled)

  // Get base URL for router (Vite sets this based on --base flag)
  // Remove trailing slash for BrowserRouter basename
  const basename = import.meta.env.BASE_URL.replace(/\/$/, "") || undefined;

  createRoot(rootElement).render(
    <Wrapper>
      <ErrorBoundary>
        <TooltipLayer />
        <BrowserRouter basename={basename}>
          <I18nProvider>
            <RouteModule>
              <App>
                <Routes>
                  <Route
                    path="/"
                    element={<Navigate to="/projects" replace />}
                  />
                  {/* Login page (no layout wrapper) */}
                  <Route path="/login" element={routeModule(<LoginPage />)} />
                  {/* IMPORTANT: Keep routes in sync with remote-main.tsx — adding a route here? Add it there too! */}
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
                    <Route
                      path="/projects"
                      element={routeModule(<ProjectsPage />)}
                    />
                    <Route
                      path="/sessions"
                      element={routeModule(<GlobalSessionsPage />)}
                    />
                    <Route
                      path="/agents"
                      element={routeModule(<AgentsPage />)}
                    />
                    <Route path="/inbox" element={routeModule(<InboxPage />)} />
                    <Route
                      path="/-/hosts"
                      element={routeModule(<HostsRoute />)}
                    />
                    <Route
                      path="/settings"
                      element={routeModule(<SettingsLayout />)}
                    />
                    <Route
                      path="/settings/:category"
                      element={routeModule(<SettingsLayout />)}
                    />
                    {/* Project-scoped pages */}
                    <Route
                      path="/projects/:projectId/workstreams"
                      element={routeModule(<WorkstreamsPage />)}
                    />
                    <Route
                      path="/projects/:projectId"
                      element={<Navigate to="/sessions" replace />}
                    />
                    <Route
                      path="/git-status"
                      element={routeModule(<GitStatusPage />)}
                    />
                    <Route
                      path="/bang-commands"
                      element={routeModule(<BangCommandsPage />)}
                    />
                    <Route
                      path="/devices"
                      element={routeModule(<EmulatorPage />)}
                    />
                    <Route
                      path="/devices/:deviceId"
                      element={routeModule(<EmulatorPage />)}
                    />
                    <Route
                      path="/new-session"
                      element={routeModule(<NewSessionPage />)}
                    />
                    <Route
                      path="/projects/:projectId/file"
                      element={routeModule(<FilePage />)}
                    />
                    <Route
                      path="/projects/:projectId/sessions/:sessionId"
                      element={routeModule(<SessionDomLingerRouteMarker />)}
                    />
                  </Route>
                  {/* Activity page has its own layout */}
                  <Route
                    path="/activity"
                    element={routeModule(<ActivityPage />)}
                  />
                </Routes>
              </App>
            </RouteModule>
          </I18nProvider>
        </BrowserRouter>
      </ErrorBoundary>
    </Wrapper>,
  );
}
