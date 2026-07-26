import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Outlet, useLocation, useOutletContext } from "react-router-dom";
import { Sidebar, SidebarToggleIcon } from "../components/Sidebar";
import { useClientSummarySourceKey } from "../lib/clientSummaryStore";
import { useSidebarPreference } from "../hooks/useSidebarPreference";
import { useSessionPerformanceSettings } from "../hooks/useSessionPerformanceSettings";
import {
  DESKTOP_BREAKPOINT,
  MIN_CONTENT_WIDTH,
  useSidebarWidth,
} from "../hooks/useSidebarWidth";
import { useRetainSidebarSessionFeeds } from "../hooks/useSidebarSessionFeeds";
import { useI18n } from "../i18n";

export interface NavigationLayoutContext {
  /** Open the mobile sidebar */
  openSidebar: () => void;
  /** Whether we're in desktop mode (wide screen) */
  isWideScreen: boolean;
  /** Desktop mode: sidebar is collapsed (icons only) */
  isSidebarCollapsed: boolean;
  /** Desktop mode: callback to toggle sidebar expanded/collapsed state */
  toggleSidebar: () => void;
}

const NOOP = () => {};
const SESSION_DOM_LINGER_TTL_MS = 60_000;
const NavigationLayoutReactContext =
  createContext<NavigationLayoutContext | null>(null);

interface SessionRouteLocationSnapshot {
  pathname: string;
  search: string;
  state: unknown;
}

interface SessionDomLingerRoute {
  key: string;
  projectId: string;
  sessionId: string;
  location: SessionRouteLocationSnapshot;
  status: "active" | "parked";
  parkedAtMs?: number;
  expiresAtMs?: number;
}

interface NavigationLayoutProps {
  sessionElement?: (
    route: SessionDomLingerRoute,
    options: { parked: boolean },
  ) => ReactNode;
}

interface ResponsiveLayoutState {
  isWideScreen: boolean;
  canShowExpandedSidebar: boolean;
}

function getViewportWidth(): number {
  return typeof window === "undefined" ? 1200 : window.innerWidth;
}

function getResponsiveLayoutState(
  sidebarWidth: number,
  viewportWidth = getViewportWidth(),
): ResponsiveLayoutState {
  return {
    isWideScreen: viewportWidth >= DESKTOP_BREAKPOINT,
    canShowExpandedSidebar: viewportWidth >= sidebarWidth + MIN_CONTENT_WIDTH,
  };
}

function responsiveLayoutStateEquals(
  left: ResponsiveLayoutState,
  right: ResponsiveLayoutState,
): boolean {
  return (
    left.isWideScreen === right.isWideScreen &&
    left.canShowExpandedSidebar === right.canShowExpandedSidebar
  );
}

function createSessionDomLingerKey(options: {
  sourceKey: string;
  projectId: string;
  sessionId: string;
  search: string;
}): string {
  return [
    encodeURIComponent(options.sourceKey),
    encodeURIComponent(options.projectId),
    encodeURIComponent(options.sessionId),
    encodeURIComponent(options.search),
  ].join(":");
}

function readSessionRouteFromPathname(
  pathname: string,
): { projectId: string; sessionId: string } | null {
  const match = pathname.match(
    /(?:^|\/)projects\/([^/]+)\/sessions\/([^/]+)\/?$/,
  );
  if (!match?.[1] || !match[2]) {
    return null;
  }
  return {
    projectId: decodeURIComponent(match[1]),
    sessionId: decodeURIComponent(match[2]),
  };
}

function isContentFrameRoutePathname(pathname: string): boolean {
  return /(?:^|\/)projects\/[^/]+\/file\/?$/.test(pathname);
}

export function SessionDomLingerRouteMarker() {
  return null;
}

/**
 * Shared layout for all pages that need a sidebar.
 * Renders the Sidebar once so it persists across route changes.
 */
export function NavigationLayout({ sessionElement }: NavigationLayoutProps) {
  useRetainSidebarSessionFeeds();
  const { sessionDomLingerEnabled } = useSessionPerformanceSettings();
  const { t } = useI18n();

  const location = useLocation();
  const currentSessionMatch = useMemo(
    () => readSessionRouteFromPathname(location.pathname),
    [location.pathname],
  );
  const isContentFrameRoute = useMemo(
    () => isContentFrameRoutePathname(location.pathname),
    [location.pathname],
  );
  const sourceKey = useClientSummarySourceKey();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const forceExpandedSidebar =
    new URLSearchParams(location.search).get("sidebar") === "expanded";
  const {
    isExpanded,
    isMinimized,
    toggleExpanded,
    minimizeToFloatingToggle,
    restoreCollapsedSidebar,
  } = useSidebarPreference(forceExpandedSidebar);
  const {
    width: sidebarWidth,
    setWidth: setSidebarWidth,
    isResizing,
    setIsResizing,
  } = useSidebarWidth();
  const [responsiveLayout, setResponsiveLayout] = useState(() =>
    getResponsiveLayoutState(sidebarWidth),
  );
  const updateResponsiveLayout = useCallback(() => {
    const next = getResponsiveLayoutState(sidebarWidth);
    setResponsiveLayout((previous) =>
      responsiveLayoutStateEquals(previous, next) ? previous : next,
    );
  }, [sidebarWidth]);

  useEffect(() => {
    updateResponsiveLayout();

    let frameId = 0;
    const handleResize = () => {
      if (frameId !== 0) {
        return;
      }
      frameId = window.requestAnimationFrame(() => {
        frameId = 0;
        updateResponsiveLayout();
      });
    };

    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      if (frameId !== 0) {
        window.cancelAnimationFrame(frameId);
      }
    };
  }, [updateResponsiveLayout]);

  const { isWideScreen, canShowExpandedSidebar } = responsiveLayout;
  // Auto-collapse if viewport too narrow for expanded sidebar, or if user prefers collapsed
  const effectivelyCollapsed = !isExpanded || !canShowExpandedSidebar;

  // Close mobile sidebar overlay when viewport becomes wide enough for expanded desktop sidebar
  // This prevents having both sidebars visible after window resize/device rotation
  // Only auto-close when desktop sidebar is actually visible (isWideScreen)
  useEffect(() => {
    if (sidebarOpen && isWideScreen && canShowExpandedSidebar) {
      setSidebarOpen(false);
    }
  }, [canShowExpandedSidebar, isWideScreen, sidebarOpen]);

  useEffect(() => {
    if (isContentFrameRoute && sidebarOpen) {
      setSidebarOpen(false);
    }
  }, [isContentFrameRoute, sidebarOpen]);

  // Smart toggle: if viewport can support expanded, toggle preference; otherwise open overlay
  const handleToggleExpanded = useCallback(() => {
    if (canShowExpandedSidebar) {
      toggleExpanded();
    } else {
      // Viewport too narrow for expanded sidebar - open mobile-style overlay instead
      setSidebarOpen(true);
    }
  }, [canShowExpandedSidebar, toggleExpanded]);

  const openSidebar = useCallback(() => setSidebarOpen(true), []);
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);
  const handleResizeStart = useCallback(
    () => setIsResizing(true),
    [setIsResizing],
  );
  const handleResizeEnd = useCallback(
    () => setIsResizing(false),
    [setIsResizing],
  );

  const context: NavigationLayoutContext = useMemo(
    () => ({
      openSidebar,
      isWideScreen,
      isSidebarCollapsed: effectivelyCollapsed,
      toggleSidebar: handleToggleExpanded,
    }),
    [effectivelyCollapsed, handleToggleExpanded, isWideScreen, openSidebar],
  );

  // CSS variable for sidebar width
  const containerStyle = useMemo(
    () =>
      isWideScreen
        ? ({ "--sidebar-width": `${sidebarWidth}px` } as React.CSSProperties)
        : undefined,
    [isWideScreen, sidebarWidth],
  );
  const desktopSidebarStyle = useMemo(
    () => ({ width: effectivelyCollapsed ? undefined : sidebarWidth }),
    [effectivelyCollapsed, sidebarWidth],
  );
  const currentSessionRoute = useMemo<SessionDomLingerRoute | null>(() => {
    if (!currentSessionMatch) {
      return null;
    }
    const { projectId, sessionId } = currentSessionMatch;
    return {
      key: createSessionDomLingerKey({
        sourceKey,
        projectId,
        sessionId,
        search: location.search,
      }),
      projectId,
      sessionId,
      location: {
        pathname: location.pathname,
        search: location.search,
        state: location.state,
      },
      status: "active",
    };
  }, [
    currentSessionMatch,
    location.pathname,
    location.search,
    location.state,
    sourceKey,
  ]);
  const [lingerRoute, setLingerRoute] = useState<SessionDomLingerRoute | null>(
    () => currentSessionRoute,
  );
  const sessionLayerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!sessionDomLingerEnabled) {
      setLingerRoute(currentSessionRoute);
      return;
    }
    if (currentSessionRoute) {
      setLingerRoute(currentSessionRoute);
      return;
    }
    setLingerRoute((previous) => {
      if (!previous || previous.status === "parked") {
        return previous;
      }
      const now = Date.now();
      return {
        ...previous,
        status: "parked",
        parkedAtMs: now,
        expiresAtMs: now + SESSION_DOM_LINGER_TTL_MS,
      };
    });
  }, [currentSessionRoute, sessionDomLingerEnabled]);

  useEffect(() => {
    if (lingerRoute?.status !== "parked") {
      return;
    }
    const timeoutMs = Math.max(0, (lingerRoute.expiresAtMs ?? 0) - Date.now());
    const timer = window.setTimeout(() => {
      setLingerRoute((previous) =>
        previous?.key === lingerRoute.key && previous.status === "parked"
          ? null
          : previous,
      );
    }, timeoutMs);
    return () => window.clearTimeout(timer);
  }, [lingerRoute]);

  const parkedSessionRoute =
    sessionDomLingerEnabled && !currentSessionRoute ? lingerRoute : null;
  const renderedSessionRoute = currentSessionRoute ?? parkedSessionRoute;
  const sessionLayerVisible = Boolean(
    currentSessionRoute &&
      renderedSessionRoute &&
      currentSessionRoute.key === renderedSessionRoute.key,
  );
  const sessionLayerParked = Boolean(
    renderedSessionRoute && !sessionLayerVisible,
  );

  useEffect(() => {
    const element = sessionLayerRef.current as
      | (HTMLDivElement & { inert?: boolean })
      | null;
    if (!element) {
      return;
    }
    element.inert = sessionLayerParked;
  }, [sessionLayerParked]);

  return (
    <div
      className={`session-page ${isWideScreen ? "desktop-layout" : ""} ${
        isContentFrameRoute ? "content-frame-layout" : ""
      } ${isResizing ? "resizing" : ""}`}
      style={containerStyle}
    >
      {/* Desktop sidebar - always visible on wide screens; the minimized mode
          renders the floating restore toggle in its place */}
      {isWideScreen &&
        !isContentFrameRoute &&
        (isMinimized ? (
          <button
            type="button"
            className="sidebar-toggle sidebar-floating-restore"
            onClick={restoreCollapsedSidebar}
            title={t("actionRestoreSidebar")}
            aria-label={t("actionRestoreSidebar")}
          >
            <SidebarToggleIcon />
          </button>
        ) : (
          <aside
            className={`sidebar-desktop ${effectivelyCollapsed ? "sidebar-collapsed" : ""} ${isResizing ? "resizing" : ""}`}
            style={desktopSidebarStyle}
          >
            <Sidebar
              isOpen={true}
              onClose={NOOP}
              onNavigate={NOOP}
              currentSessionId={currentSessionMatch?.sessionId}
              isDesktop={true}
              isCollapsed={effectivelyCollapsed}
              onToggleExpanded={handleToggleExpanded}
              onMinimize={minimizeToFloatingToggle}
              sidebarWidth={sidebarWidth}
              onResizeStart={handleResizeStart}
              onResize={setSidebarWidth}
              onResizeEnd={handleResizeEnd}
            />
          </aside>
        ))}

      {/* Mobile sidebar - modal overlay (also used for constrained desktop overlay) */}
      {!isContentFrameRoute && (!isWideScreen || sidebarOpen) && (
        <Sidebar
          isOpen={sidebarOpen}
          onClose={closeSidebar}
          onNavigate={closeSidebar}
          currentSessionId={currentSessionMatch?.sessionId}
        />
      )}

      <NavigationLayoutReactContext.Provider value={context}>
        <div className="navigation-route-stack">
          {renderedSessionRoute && sessionElement && (
            <div
              key={renderedSessionRoute.key}
              ref={sessionLayerRef}
              className={`navigation-route-layer session-dom-linger-layer ${
                sessionLayerVisible ? "is-active" : "is-parked"
              }`}
              aria-hidden={sessionLayerParked ? true : undefined}
              data-session-dom-linger={
                sessionLayerVisible ? "active" : "parked"
              }
            >
              {sessionElement(renderedSessionRoute, {
                parked: sessionLayerParked,
              })}
            </div>
          )}
          <div
            className={`navigation-route-layer navigation-route-foreground ${
              sessionLayerVisible ? "is-hidden" : "is-active"
            }`}
            aria-hidden={sessionLayerVisible ? true : undefined}
          >
            <Outlet context={context} />
          </div>
        </div>
      </NavigationLayoutReactContext.Provider>
    </div>
  );
}

/**
 * Hook for child routes to access the shared navigation layout context.
 */
export function useNavigationLayout(): NavigationLayoutContext {
  const context = useContext(NavigationLayoutReactContext);
  const outletContext = useOutletContext<NavigationLayoutContext | null>();
  if (context) {
    return context;
  }
  if (outletContext) {
    return outletContext;
  }
  throw new Error("useNavigationLayout must be used under NavigationLayout");
}
