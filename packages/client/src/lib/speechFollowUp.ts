export interface SpeechFollowUpSnapshot {
  active: boolean;
  deadlineMs: number | null;
  expired: boolean;
  speechStarted: boolean;
  owner: object | null;
}

const EMPTY_SNAPSHOT: SpeechFollowUpSnapshot = {
  active: false,
  deadlineMs: null,
  expired: false,
  speechStarted: false,
  owner: null,
};

const subscribers = new Set<() => void>();
let snapshot = EMPTY_SNAPSHOT;
let expiryTimer: ReturnType<typeof setTimeout> | null = null;
let onEnd: (() => void) | null = null;

function emit(): void {
  for (const subscriber of subscribers) subscriber();
}

function clearExpiryTimer(): void {
  if (expiryTimer !== null) {
    clearTimeout(expiryTimer);
    expiryTimer = null;
  }
}

function endFollowUp(): void {
  if (!snapshot.active) return;
  clearExpiryTimer();
  const cleanup = onEnd;
  onEnd = null;
  snapshot = EMPTY_SNAPSHOT;
  emit();
  cleanup?.();
}

function expireFollowUp(): void {
  if (!snapshot.active) return;
  expiryTimer = null;
  if (!snapshot.speechStarted) {
    endFollowUp();
    return;
  }
  snapshot = { ...snapshot, expired: true };
  emit();
}

export function getSpeechFollowUpSnapshot(): SpeechFollowUpSnapshot {
  return snapshot;
}

export function subscribeSpeechFollowUp(subscriber: () => void): () => void {
  subscribers.add(subscriber);
  return () => subscribers.delete(subscriber);
}

export function armSpeechFollowUp(
  durationMs: number,
  owner: object,
  cleanup: () => void,
): void {
  if (durationMs <= 0) {
    endFollowUp();
    return;
  }
  clearExpiryTimer();
  const deadlineMs = Date.now() + durationMs;
  snapshot = {
    active: true,
    deadlineMs,
    expired: false,
    speechStarted: false,
    owner,
  };
  onEnd = cleanup;
  expiryTimer = setTimeout(expireFollowUp, durationMs);
  emit();
}

export function claimSpeechFollowUp(
  owner: object,
  cleanup: () => void,
): boolean {
  if (!snapshot.active) return false;
  if (snapshot.owner !== null && snapshot.owner !== owner) return false;
  if (snapshot.owner !== owner) {
    snapshot = { ...snapshot, owner };
    emit();
  }
  onEnd = cleanup;
  return true;
}

export function releaseSpeechFollowUpOwner(owner: object): void {
  if (!snapshot.active || snapshot.owner !== owner) return;
  snapshot = { ...snapshot, owner: null };
  emit();
}

export function noteSpeechFollowUpActivity(owner: object): void {
  if (!snapshot.active || snapshot.owner !== owner || snapshot.speechStarted) {
    return;
  }
  snapshot = { ...snapshot, speechStarted: true };
  emit();
}

export function cancelSpeechFollowUp(owner?: object): void {
  if (owner && snapshot.owner !== null && snapshot.owner !== owner) return;
  endFollowUp();
}
