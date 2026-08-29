import {
  Profiler,
  createContext,
  startTransition,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Link,
  Outlet,
  UNSAFE_LocationContext,
  UNSAFE_NavigationContext,
  UNSAFE_RouteContext,
  useLocation,
  useNavigate,
  useOutletContext,
} from "react-router-dom";
import { Sidebar, SidebarToggleIcon } from "../components/Sidebar";
import { GlossaryProjectProvider } from "../contexts/GlossaryContext";
import { useClientSummarySourceKey } from "../lib/clientSummaryStore";
import { MOBILE_KEYBOARD_OPEN_VIEWPORT_RATIO } from "../lib/mobileKeyboardViewport";
import { useSidebarPreference } from "../hooks/useSidebarPreference";
import { useSessionPerformanceSettings } from "../hooks/useSessionPerformanceSettings";
import {
  DESKTOP_BREAKPOINT,
  MIN_CONTENT_WIDTH,
  useSidebarWidth,
} from "../hooks/useSidebarWidth";
import { SidebarSessionFeedsProvider } from "../hooks/useSidebarSessionFeeds";
import { useI18n } from "../i18n";
import { markReloadPerfPhase } from "../lib/diagnostics/reloadPerfProbe";

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
const SESSION_DOM_LINGER_MAX_PARKED_ELEMENTS = 5_000;
const NON_TEXT_INPUT_TYPES = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "hidden",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);
const NavigationLayoutReactContext =
  createContext<NavigationLayoutContext | null>(null);

interface SessionRouteLocationSnapshot {
  hash: string;
  key: string;
  pathname: string;
  search: string;
  state: unknown;
}

interface SessionDomLingerRoute {
  key: string;
  sourceKey: string;
  projectId: string;
  sessionId: string;
  location: SessionRouteLocationSnapshot;
  status: "active" | "parked";
  parkedAtMs?: number;
  expiresAtMs?: number;
}

interface PendingSessionDomLingerSwap {
  fromKey: string;
  retainOutgoing: boolean;
  targetKey: string;
}

interface SessionDomLingerRenderSignal {
  current: boolean;
  supportsCompaction: boolean;
}

interface NavigationLayoutProps {
  sessionElement?: (
    route: SessionDomLingerRoute,
    options: {
      parked: boolean;
      progressiveRenderPauseSignal: SessionDomLingerRenderSignal;
    },
  ) => ReactNode;
}

interface SessionDomLingerLayerHandle {
  element: HTMLDivElement;
  progressiveRenderPauseSignal: SessionDomLingerRenderSignal;
}

interface SessionDomLingerLayerProps {
  parked: boolean;
  route: SessionDomLingerRoute;
  sessionElement: NonNullable<NavigationLayoutProps["sessionElement"]>;
  layerRefs: React.MutableRefObject<Map<string, SessionDomLingerLayerHandle>>;
  subtreeParked: boolean;
}

function SessionDomLingerLayer({
  parked,
  route,
  sessionElement,
  layerRefs,
  subtreeParked,
}: SessionDomLingerLayerProps) {
  const parentLocationContext = useContext(UNSAFE_LocationContext);
  const parentRouteContext = useContext(UNSAFE_RouteContext);
  if (!parentLocationContext) {
    throw new Error("Session DOM linger requires a router location context");
  }
  const [sessionRoute] = useState(route);
  const [progressiveRenderPauseSignal] = useState(() => ({
    current: parked,
    supportsCompaction: false,
  }));
  progressiveRenderPauseSignal.current = parked;
  const [committedSubtreeParked, setCommittedSubtreeParked] =
    useState(subtreeParked);
  useEffect(() => {
    if (committedSubtreeParked === subtreeParked) {
      return;
    }
    startTransition(() => setCommittedSubtreeParked(subtreeParked));
  }, [committedSubtreeParked, subtreeParked]);
  const [sessionLocationContext] = useState(() => ({
    location: sessionRoute.location,
    navigationType: parentLocationContext.navigationType,
  }));
  const [sessionRouteContext] = useState(parentRouteContext);
  const subtree = useMemo(
    () =>
      sessionElement(sessionRoute, {
        parked: committedSubtreeParked,
        progressiveRenderPauseSignal,
      }),
    [
      committedSubtreeParked,
      progressiveRenderPauseSignal,
      sessionElement,
      sessionRoute,
    ],
  );
  const scopedSubtree = useMemo(
    () => (
      <UNSAFE_LocationContext.Provider value={sessionLocationContext}>
        <UNSAFE_RouteContext.Provider value={sessionRouteContext}>
          {subtree}
        </UNSAFE_RouteContext.Provider>
      </UNSAFE_LocationContext.Provider>
    ),
    [sessionLocationContext, sessionRouteContext, subtree],
  );
  const handleRender = useCallback<React.ProfilerOnRenderCallback>(
    (_id, phase, actualDuration, baseDuration) => {
      markReloadPerfPhase("session_dom_linger_layer_render", {
        actualDuration,
        baseDuration,
        phase,
        sessionId: sessionRoute.sessionId,
        subtreeParked: committedSubtreeParked,
      });
    },
    [committedSubtreeParked, sessionRoute.sessionId],
  );

  return (
    <div
      ref={(element) => {
        if (element) {
          layerRefs.current.set(sessionRoute.key, {
            element,
            progressiveRenderPauseSignal,
          });
        } else {
          layerRefs.current.delete(sessionRoute.key);
        }
      }}
      className={`navigation-route-layer session-dom-linger-layer ${
        parked ? "is-parked" : "is-active"
      }`}
      aria-hidden={parked ? true : undefined}
      data-session-dom-linger={parked ? "parked" : "active"}
    >
      {typeof window !== "undefined" &&
      window.__YA_RELOAD_PERF_PROBE__?.mark ? (
        <Profiler id={sessionRoute.key} onRender={handleRender}>
          {scopedSubtree}
        </Profiler>
      ) : (
        scopedSubtree
      )}
    </div>
  );
}

interface ResponsiveLayoutState {
  isWideScreen: boolean;
  canShowExpandedSidebar: boolean;
}

function getViewportWidth(): number {
  return typeof window === "undefined" ? 1200 : window.innerWidth;
}

function isKeyboardTextEntry(
  target: EventTarget | null,
): target is HTMLElement {
  if (target instanceof HTMLTextAreaElement) {
    return !target.disabled && !target.readOnly;
  }
  if (target instanceof HTMLInputElement) {
    return (
      !target.disabled &&
      !target.readOnly &&
      !NON_TEXT_INPUT_TYPES.has(target.type)
    );
  }
  return target instanceof HTMLElement && target.isContentEditable;
}

function getMobileVisualViewportBottomInset(
  isWideScreen: boolean,
  activeElement: EventTarget | null = document.activeElement,
): number {
  const visualViewport = window.visualViewport;
  const layoutViewportHeight = window.innerHeight;
  if (
    isWideScreen ||
    !visualViewport ||
    !isKeyboardTextEntry(activeElement) ||
    layoutViewportHeight <= 0 ||
    visualViewport.height >=
      layoutViewportHeight * MOBILE_KEYBOARD_OPEN_VIEWPORT_RATIO
  ) {
    return 0;
  }

  const visualViewportBottom =
    Math.max(0, visualViewport.offsetTop) + Math.max(0, visualViewport.height);
  return Math.ceil(Math.max(0, layoutViewportHeight - visualViewportBottom));
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

function readSidebarSessionRouteFromPathname(
  pathname: string,
): { projectId: string; sessionId: string } | null {
  const match = pathname.match(/(?:^|\/)projects\/([^/]+)\/sessions\/([^/]+)/);
  if (!match?.[1] || !match[2]) {
    return null;
  }
  return {
    projectId: decodeURIComponent(match[1]),
    sessionId: decodeURIComponent(match[2]),
  };
}

function readProjectIdFromPathname(pathname: string): string | null {
  const match = pathname.match(/(?:^|\/)projects\/([^/]+)/);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
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
export function NavigationLayout(props: NavigationLayoutProps) {
  return <NavigationLayoutFrame {...props} />;
}

function NavigationLayoutFrame({ sessionElement }: NavigationLayoutProps) {
  const { sessionDomLingerEnabled } = useSessionPerformanceSettings();
  const { t } = useI18n();

  const location = useLocation();
  const navigate = useNavigate();
  const navigationContext = useContext(UNSAFE_NavigationContext);
  const currentSessionMatch = useMemo(
    () => readSessionRouteFromPathname(location.pathname),
    [location.pathname],
  );
  const sidebarSessionMatch = useMemo(
    () => readSidebarSessionRouteFromPathname(location.pathname),
    [location.pathname],
  );
  const currentProjectId = useMemo(
    () => readProjectIdFromPathname(location.pathname),
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
  const layoutFrameRef = useRef<HTMLDivElement | null>(null);
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

  useEffect(() => {
    const frame = layoutFrameRef.current;
    if (!frame) {
      return;
    }

    const applyInset = (activeElement: EventTarget | null) => {
      const inset = getMobileVisualViewportBottomInset(
        isWideScreen,
        activeElement,
      );
      if (inset > 0) {
        frame.style.paddingBottom = `calc(env(safe-area-inset-bottom, 0px) + ${inset}px)`;
      } else {
        frame.style.removeProperty("padding-bottom");
      }
    };
    const updateInset = () => applyInset(document.activeElement);
    const handleFocusIn = (event: FocusEvent) => applyInset(event.target);
    const handleFocusOut = (event: FocusEvent) =>
      applyInset(event.relatedTarget);

    updateInset();
    window.addEventListener("resize", updateInset);
    window.visualViewport?.addEventListener("resize", updateInset);
    window.visualViewport?.addEventListener("scroll", updateInset);
    document.addEventListener("focusin", handleFocusIn);
    document.addEventListener("focusout", handleFocusOut);
    return () => {
      window.removeEventListener("resize", updateInset);
      window.visualViewport?.removeEventListener("resize", updateInset);
      window.visualViewport?.removeEventListener("scroll", updateInset);
      document.removeEventListener("focusin", handleFocusIn);
      document.removeEventListener("focusout", handleFocusOut);
    };
  }, [isWideScreen]);

  // Auto-collapse if viewport too narrow for expanded sidebar, or if user prefers collapsed
  const effectivelyCollapsed = !isExpanded || !canShowExpandedSidebar;

  // Close mobile sidebar overlay when viewport becomes wide enough for expanded desktop sidebar
  // This prevents having both sidebars visible after window resize/device rotation
  // Only auto-close when desktop sidebar is actually visible (isWideScreen)
  useEffect(() => {
    if (
      !isContentFrameRoute &&
      sidebarOpen &&
      isWideScreen &&
      canShowExpandedSidebar
    ) {
      setSidebarOpen(false);
    }
  }, [canShowExpandedSidebar, isContentFrameRoute, isWideScreen, sidebarOpen]);

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
      sourceKey,
      projectId,
      sessionId,
      location: {
        hash: location.hash,
        key: location.key,
        pathname: location.pathname,
        search: location.search,
        state: location.state,
      },
      status: "active",
    };
  }, [
    currentSessionMatch,
    location.pathname,
    location.hash,
    location.key,
    location.search,
    location.state,
    sourceKey,
  ]);
  const [parkedSessionRoute, setParkedSessionRoute] =
    useState<SessionDomLingerRoute | null>(null);
  const [committedActiveSessionRoute, setCommittedActiveSessionRoute] =
    useState(currentSessionRoute);
  const pendingSessionSwapRef = useRef<PendingSessionDomLingerSwap | null>(
    null,
  );
  const pendingSessionSwap = pendingSessionSwapRef.current;
  const sessionLayerRefs = useRef(
    new Map<string, SessionDomLingerLayerHandle>(),
  );
  const pendingSwapRejectsOutgoing =
    pendingSessionSwap?.retainOutgoing === false &&
    committedActiveSessionRoute?.key === pendingSessionSwap.fromKey &&
    currentSessionRoute?.key === pendingSessionSwap.targetKey;
  const transitioningFromSessionRoute =
    sessionDomLingerEnabled &&
    !pendingSwapRejectsOutgoing &&
    committedActiveSessionRoute &&
    committedActiveSessionRoute.key !== currentSessionRoute?.key &&
    committedActiveSessionRoute.sourceKey === sourceKey &&
    (!currentSessionRoute ||
      (committedActiveSessionRoute.projectId ===
        currentSessionRoute.projectId &&
        committedActiveSessionRoute.sessionId !==
          currentSessionRoute.sessionId))
      ? committedActiveSessionRoute
      : null;
  const parkedSessionCandidate =
    transitioningFromSessionRoute ?? parkedSessionRoute;
  const renderedParkedSessionRoute =
    sessionDomLingerEnabled &&
    parkedSessionCandidate &&
    parkedSessionCandidate.key !== currentSessionRoute?.key &&
    parkedSessionCandidate.sourceKey === sourceKey &&
    (!currentSessionRoute ||
      parkedSessionCandidate.projectId === currentSessionRoute.projectId)
      ? { ...parkedSessionCandidate, status: "parked" as const }
      : null;
  const renderedSessionRoutes = currentSessionRoute
    ? [currentSessionRoute, renderedParkedSessionRoute].filter(
        (route): route is SessionDomLingerRoute => route !== null,
      )
    : renderedParkedSessionRoute
      ? [renderedParkedSessionRoute]
      : [];
  const sessionLayerVisible = Boolean(currentSessionRoute);

  useLayoutEffect(() => {
    const pendingSwap = pendingSessionSwapRef.current;
    if (
      pendingSwap &&
      (!sessionDomLingerEnabled ||
        currentSessionRoute?.key !== pendingSwap.fromKey)
    ) {
      pendingSessionSwapRef.current = null;
    }
  }, [currentSessionRoute?.key, sessionDomLingerEnabled]);

  useLayoutEffect(() => {
    const previousActiveRoute = committedActiveSessionRoute;
    setCommittedActiveSessionRoute(currentSessionRoute);
    setParkedSessionRoute((previousParkedRoute) => {
      if (!sessionDomLingerEnabled) {
        return null;
      }

      let nextParkedRoute = previousParkedRoute;
      if (
        previousActiveRoute &&
        previousActiveRoute.key !== currentSessionRoute?.key &&
        previousActiveRoute.sourceKey === sourceKey &&
        (!currentSessionRoute ||
          (previousActiveRoute.projectId === currentSessionRoute.projectId &&
            previousActiveRoute.sessionId !== currentSessionRoute.sessionId))
      ) {
        const now = Date.now();
        nextParkedRoute = {
          ...previousActiveRoute,
          status: "parked",
          parkedAtMs: now,
          expiresAtMs: now + SESSION_DOM_LINGER_TTL_MS,
        };
      }

      if (!nextParkedRoute) {
        return null;
      }
      if (
        nextParkedRoute.key === currentSessionRoute?.key ||
        nextParkedRoute.sourceKey !== sourceKey ||
        (currentSessionRoute &&
          nextParkedRoute.projectId !== currentSessionRoute.projectId)
      ) {
        return null;
      }
      if (currentSessionRoute) {
        const layer = sessionLayerRefs.current.get(nextParkedRoute.key);
        if (
          !layer ||
          (!layer.progressiveRenderPauseSignal.supportsCompaction &&
            layer.element.querySelectorAll("*").length >
              SESSION_DOM_LINGER_MAX_PARKED_ELEMENTS)
        ) {
          return null;
        }
      }
      return nextParkedRoute;
    });
  }, [
    committedActiveSessionRoute,
    currentSessionRoute,
    sessionDomLingerEnabled,
    sourceKey,
  ]);

  useEffect(() => {
    if (parkedSessionRoute?.status !== "parked") {
      return;
    }
    const timeoutMs = Math.max(
      0,
      (parkedSessionRoute.expiresAtMs ?? 0) - Date.now(),
    );
    const timer = window.setTimeout(() => {
      setParkedSessionRoute((previous) =>
        previous?.key === parkedSessionRoute.key && previous.status === "parked"
          ? null
          : previous,
      );
    }, timeoutMs);
    return () => window.clearTimeout(timer);
  }, [parkedSessionRoute]);

  useLayoutEffect(() => {
    for (const [key, layer] of sessionLayerRefs.current) {
      (layer.element as HTMLDivElement & { inert?: boolean }).inert =
        key !== currentSessionRoute?.key;
      layer.progressiveRenderPauseSignal.current =
        key !== currentSessionRoute?.key;
    }
  }, [currentSessionRoute?.key]);

  const handleSessionLinkCapture = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (
        !sessionDomLingerEnabled ||
        !currentSessionRoute ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }
      const anchor = target.closest<HTMLAnchorElement>(
        "a.session-list-item__link[href]",
      );
      if (!anchor) {
        return;
      }
      const targetUrl = new URL(anchor.href, window.location.href);
      if (targetUrl.origin !== window.location.origin) {
        return;
      }
      const targetMatch = readSessionRouteFromPathname(targetUrl.pathname);
      if (
        !targetMatch ||
        targetMatch.projectId !== currentSessionRoute.projectId ||
        targetMatch.sessionId === currentSessionRoute.sessionId
      ) {
        return;
      }
      const targetKey = createSessionDomLingerKey({
        sourceKey,
        projectId: targetMatch.projectId,
        sessionId: targetMatch.sessionId,
        search: targetUrl.search,
      });
      if (!sessionLayerRefs.current.has(targetKey)) {
        return;
      }
      const outgoingLayer = sessionLayerRefs.current.get(
        currentSessionRoute.key,
      );
      const retainOutgoing =
        outgoingLayer !== undefined &&
        (outgoingLayer.progressiveRenderPauseSignal.supportsCompaction ||
          outgoingLayer.element.querySelectorAll("*").length <=
            SESSION_DOM_LINGER_MAX_PARKED_ELEMENTS);

      event.preventDefault();
      for (const [key, layer] of sessionLayerRefs.current) {
        const active = key === targetKey;
        const { element, progressiveRenderPauseSignal } = layer;
        progressiveRenderPauseSignal.current = !active;
        element.classList.toggle("is-active", active);
        element.classList.toggle("is-parked", !active);
        if (active) {
          element.removeAttribute("aria-hidden");
        } else {
          element.setAttribute("aria-hidden", "true");
        }
        element.dataset.sessionDomLinger = active ? "active" : "parked";
        (element as HTMLDivElement & { inert?: boolean }).inert = !active;
      }
      pendingSessionSwapRef.current = {
        fromKey: currentSessionRoute.key,
        retainOutgoing,
        targetKey,
      };
      markReloadPerfPhase("session_dom_linger_visual_swap", {
        sessionId: targetMatch.sessionId,
      });
      startTransition(() => {
        const basename = navigationContext?.basename ?? "/";
        const pathname =
          basename !== "/" &&
          (targetUrl.pathname === basename ||
            targetUrl.pathname.startsWith(`${basename}/`))
            ? targetUrl.pathname.slice(basename.length) || "/"
            : targetUrl.pathname;
        navigate({
          hash: targetUrl.hash,
          pathname,
          search: targetUrl.search,
        });
      });
    },
    [
      currentSessionRoute,
      navigate,
      navigationContext?.basename,
      sessionDomLingerEnabled,
      sourceKey,
    ],
  );

  const sidebarFeedsEnabled = isContentFrameRoute
    ? sidebarOpen
    : (isWideScreen && !isMinimized) || (!isWideScreen && sidebarOpen);

  return (
    <SidebarSessionFeedsProvider enabled={sidebarFeedsEnabled}>
      <div
        ref={layoutFrameRef}
        onClickCapture={handleSessionLinkCapture}
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
            <Link
              to={{
                pathname: location.pathname,
                search: location.search,
                hash: location.hash,
              }}
              className="sidebar-toggle sidebar-floating-restore"
              role="button"
              onClick={(event) => {
                if (
                  event.button !== 0 ||
                  event.metaKey ||
                  event.ctrlKey ||
                  event.shiftKey ||
                  event.altKey
                ) {
                  return;
                }
                event.preventDefault();
                restoreCollapsedSidebar();
              }}
              onKeyDown={(event) => {
                if (event.key !== " ") {
                  return;
                }
                event.preventDefault();
                restoreCollapsedSidebar();
              }}
              title={t("actionRestoreSidebar")}
              aria-label={t("actionRestoreSidebar")}
            >
              <SidebarToggleIcon />
            </Link>
          ) : (
            <aside
              className={`sidebar-desktop ${effectivelyCollapsed ? "sidebar-collapsed" : ""} ${isResizing ? "resizing" : ""}`}
              style={desktopSidebarStyle}
            >
              <Sidebar
                isOpen={true}
                onClose={NOOP}
                onNavigate={NOOP}
                currentSessionId={sidebarSessionMatch?.sessionId}
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
        {(isContentFrameRoute ? sidebarOpen : !isWideScreen || sidebarOpen) && (
          <Sidebar
            isOpen={sidebarOpen}
            onClose={closeSidebar}
            onNavigate={closeSidebar}
            currentSessionId={sidebarSessionMatch?.sessionId}
          />
        )}

        <GlossaryProjectProvider
          projectId={currentProjectId ?? ""}
          enabled={currentProjectId !== null}
        >
          <NavigationLayoutReactContext.Provider value={context}>
            <div className="navigation-route-stack">
              {sessionElement &&
                renderedSessionRoutes.map((route) => {
                  const parked = route.key !== currentSessionRoute?.key;
                  return (
                    <SessionDomLingerLayer
                      key={route.key}
                      parked={parked}
                      route={route}
                      sessionElement={sessionElement}
                      layerRefs={sessionLayerRefs}
                      subtreeParked={parked}
                    />
                  );
                })}
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
        </GlossaryProjectProvider>
      </div>
    </SidebarSessionFeedsProvider>
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
