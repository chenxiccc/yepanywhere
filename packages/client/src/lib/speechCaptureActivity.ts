export type SpeechCapturePhase = "starting" | "capturing";

const activeOwners = new Map<object, SpeechCapturePhase>();
const originalMutedStates = new Map<HTMLMediaElement, boolean>();

let activePhase: SpeechCapturePhase | null = null;
let mediaObserver: MutationObserver | null = null;

function muteMediaElement(element: HTMLMediaElement): void {
  if (!originalMutedStates.has(element)) {
    originalMutedStates.set(element, element.muted);
  }
  element.muted = true;
}

function muteMediaIn(root: ParentNode): void {
  if (root instanceof HTMLMediaElement) muteMediaElement(root);
  for (const element of root.querySelectorAll?.("audio, video") ?? []) {
    muteMediaElement(element as HTMLMediaElement);
  }
}

function keepMediaMuted(event: Event): void {
  if (event.target instanceof HTMLMediaElement) {
    muteMediaElement(event.target);
  }
}

function startMediaMuting(): void {
  if (typeof document === "undefined") return;
  muteMediaIn(document);
  document.addEventListener("play", keepMediaMuted, true);
  document.addEventListener("volumechange", keepMediaMuted, true);
  if (typeof MutationObserver === "undefined") return;
  mediaObserver = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node instanceof Element) muteMediaIn(node);
      }
    }
  });
  mediaObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
}

function stopMediaMuting(): void {
  if (typeof document !== "undefined") {
    document.removeEventListener("play", keepMediaMuted, true);
    document.removeEventListener("volumechange", keepMediaMuted, true);
  }
  mediaObserver?.disconnect();
  mediaObserver = null;
  for (const [element, wasMuted] of originalMutedStates) {
    element.muted = wasMuted;
  }
  originalMutedStates.clear();
}

function aggregatePhase(): SpeechCapturePhase | null {
  let starting = false;
  for (const phase of activeOwners.values()) {
    if (phase === "capturing") return "capturing";
    starting = true;
  }
  return starting ? "starting" : null;
}

function publishAggregatePhase(): void {
  const nextPhase = aggregatePhase();
  if (nextPhase === activePhase) return;
  const wasActive = activePhase !== null;
  activePhase = nextPhase;

  if (typeof document !== "undefined") {
    if (nextPhase) {
      document.documentElement.dataset.speechCapture = nextPhase;
    } else {
      delete document.documentElement.dataset.speechCapture;
    }
  }

  if (!wasActive && nextPhase) startMediaMuting();
  if (wasActive && !nextPhase) stopMediaMuting();
}

/**
 * Coordinate capture effects across every mounted composer. A stable owner
 * token prevents one idle composer from undoing another composer's capture.
 */
export function setSpeechCaptureActivity(
  owner: object,
  phase: SpeechCapturePhase | null,
): void {
  if (phase) activeOwners.set(owner, phase);
  else activeOwners.delete(owner);
  publishAggregatePhase();
}

/** Test-only reset for module state shared across jsdom test cases. */
export function resetSpeechCaptureActivityForTests(): void {
  activeOwners.clear();
  activePhase = null;
  stopMediaMuting();
  if (typeof document !== "undefined") {
    delete document.documentElement.dataset.speechCapture;
  }
}
