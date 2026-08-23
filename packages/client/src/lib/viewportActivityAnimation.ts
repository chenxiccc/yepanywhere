const ANIMATION_PLAY_STATE_PROPERTY = "--ya-activity-play";

type ActivityListener = (active: boolean) => void;

interface ActivityObservation {
  active: boolean | null;
  intersectsViewport: boolean;
  subscriptions: Map<symbol, ActivityListener | undefined>;
}

const observations = new Map<HTMLElement, ActivityObservation>();
let viewportObserver: IntersectionObserver | null = null;

function isDocumentVisible(): boolean {
  return document.visibilityState === "visible";
}

function updateObservation(
  element: HTMLElement,
  observation: ActivityObservation,
) {
  const active = observation.intersectsViewport && isDocumentVisible();
  element.style.setProperty(
    ANIMATION_PLAY_STATE_PROPERTY,
    active ? "running" : "paused",
  );
  if (observation.active === active) return;

  observation.active = active;
  for (const listener of observation.subscriptions.values()) {
    listener?.(active);
  }
}

function handleViewportChanges(entries: IntersectionObserverEntry[]) {
  for (const entry of entries) {
    const element = entry.target as HTMLElement;
    const observation = observations.get(element);
    if (!observation) continue;
    observation.intersectsViewport = entry.isIntersecting;
    updateObservation(element, observation);
  }
}

function getViewportObserver(): IntersectionObserver | null {
  if (typeof window.IntersectionObserver !== "function") return null;
  viewportObserver ??= new window.IntersectionObserver(handleViewportChanges);
  return viewportObserver;
}

function handleVisibilityChange() {
  for (const [element, observation] of observations) {
    updateObservation(element, observation);
  }
}

/**
 * Pause an activity animation while its owning element is outside the viewport
 * or the document is hidden. Every caller shares one IntersectionObserver.
 */
export function observeViewportActivityAnimation(
  element: HTMLElement,
  listener?: ActivityListener,
): () => void {
  const token = Symbol("activity-animation");
  let observation = observations.get(element);
  if (observation) {
    observation.subscriptions.set(token, listener);
    listener?.(observation.active ?? false);
  } else {
    const observer = getViewportObserver();
    observation = {
      active: null,
      intersectsViewport: observer === null,
      subscriptions: new Map([[token, listener]]),
    };
    const shouldListenForVisibility = observations.size === 0;
    observations.set(element, observation);
    if (shouldListenForVisibility) {
      document.addEventListener("visibilitychange", handleVisibilityChange);
    }
    observer?.observe(element);
    updateObservation(element, observation);
  }

  return () => {
    const current = observations.get(element);
    if (!current) return;
    current.subscriptions.delete(token);
    if (current.subscriptions.size > 0) return;

    viewportObserver?.unobserve(element);
    observations.delete(element);
    element.style.removeProperty(ANIMATION_PLAY_STATE_PROPERTY);
    if (observations.size === 0) {
      viewportObserver?.disconnect();
      viewportObserver = null;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    }
  };
}
