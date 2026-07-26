/**
 * A tiny per-project pub/sub so the diff-line comment layer and the review
 * tray/modal stay in sync without threading a provider through the git-status
 * tree (topic: source-review-to-session). Emitters call
 * `notifyReviewCommentsChanged` after a mutation; subscribers refetch.
 */

type Listener = () => void;

const listeners = new Map<string, Set<Listener>>();

export function subscribeReviewComments(
  projectId: string,
  listener: Listener,
): () => void {
  let set = listeners.get(projectId);
  if (!set) {
    set = new Set();
    listeners.set(projectId, set);
  }
  set.add(listener);
  return () => {
    set?.delete(listener);
    if (set && set.size === 0) listeners.delete(projectId);
  };
}

export function notifyReviewCommentsChanged(projectId: string): void {
  for (const listener of listeners.get(projectId) ?? []) listener();
}
