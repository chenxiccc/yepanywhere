import { Fragment, StrictMode } from "react";
import { createRoot } from "react-dom/client";

// Toggle to disable StrictMode for easier debugging (avoids double renders)
const STRICT_MODE = false;
const Wrapper = STRICT_MODE ? StrictMode : Fragment;
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { App } from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { TooltipLayer } from "./components/ui/TooltipLayer";
import { initializeFontSize } from "./hooks/useFontSize";
import { initializeSidebarSpacing } from "./hooks/useSidebarSpacing";
import { initializeContentMaxWidth } from "./hooks/useContentMaxWidth";
import { initializeOutputAppearance } from "./hooks/useOutputAppearance";
import { initializeTabSize } from "./hooks/useTabSize";
import { initializeTheme } from "./hooks/useTheme";
import { initializeTooltipAppearance } from "./hooks/useTooltipAppearance";
import { registerServiceWorkerAtStartup } from "./lib/registerServiceWorker";
import { NavigationLayout, SessionDomLingerRouteMarker } from "./layouts";
import { ActivityPage } from "./pages/ActivityPage";
import { AgentsPage } from "./pages/AgentsPage";
import { BangCommandsPage } from "./pages/BangCommandsPage";
import { EmulatorPage } from "./pages/EmulatorPage";
import { FilePage } from "./pages/FilePage";
import { GitStatusPage } from "./pages/GitStatusPage";
import { GlobalSessionsPage } from "./pages/GlobalSessionsPage";
import { HostsRoute } from "./pages/HostsPage";
import { InboxPage } from "./pages/InboxPage";
import { LoginPage } from "./pages/LoginPage";
import { NewSessionPage } from "./pages/NewSessionPage";
import { ProjectsPage } from "./pages/ProjectsPage";
import { SessionPage } from "./pages/SessionPage";
import { SettingsLayout } from "./pages/settings";
import { WorkstreamsPage } from "./pages/WorkstreamsPage";
import "./styles/index.css";

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
          You've hit the internal HMR / asset server on port {__VITE_DEV_PORT__},
          which has no backend. The Yep Anywhere UI runs on the main server — open
          the link below instead.
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
  registerServiceWorkerAtStartup();

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
          <App>
            <Routes>
              <Route path="/" element={<Navigate to="/projects" replace />} />
              {/* Login page (no layout wrapper) */}
              <Route path="/login" element={<LoginPage />} />
              {/* IMPORTANT: Keep routes in sync with remote-main.tsx — adding a route here? Add it there too! */}
              <Route
                element={
                  <NavigationLayout
                    sessionElement={(route, { parked }) => (
                      <SessionPage
                        key={route.key}
                        projectId={route.projectId}
                        sessionId={route.sessionId}
                        routeLocation={route.location}
                        isDomLingerParked={parked}
                      />
                    )}
                  />
                }
              >
                <Route path="/projects" element={<ProjectsPage />} />
                <Route path="/sessions" element={<GlobalSessionsPage />} />
                <Route path="/agents" element={<AgentsPage />} />
                <Route path="/inbox" element={<InboxPage />} />
                <Route path="/-/hosts" element={<HostsRoute />} />
                <Route path="/settings" element={<SettingsLayout />} />
                <Route path="/settings/:category" element={<SettingsLayout />} />
                {/* Project-scoped pages */}
                <Route
                  path="/projects/:projectId/workstreams"
                  element={<WorkstreamsPage />}
                />
                <Route
                  path="/projects/:projectId"
                  element={<Navigate to="/sessions" replace />}
                />
                <Route path="/git-status" element={<GitStatusPage />} />
                <Route path="/bang-commands" element={<BangCommandsPage />} />
                <Route path="/devices" element={<EmulatorPage />} />
                <Route path="/devices/:deviceId" element={<EmulatorPage />} />
                <Route path="/new-session" element={<NewSessionPage />} />
                <Route path="/projects/:projectId/file" element={<FilePage />} />
                <Route
                  path="/projects/:projectId/sessions/:sessionId"
                  element={<SessionDomLingerRouteMarker />}
                />
              </Route>
              {/* Activity page has its own layout */}
              <Route path="/activity" element={<ActivityPage />} />
            </Routes>
          </App>
        </BrowserRouter>
      </ErrorBoundary>
    </Wrapper>,
  );
}
