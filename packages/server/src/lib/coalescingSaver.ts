/**
 * Coalesce concurrent async saves onto one writer. At most one `write` runs at
 * a time; a save() issued while one is running marks a follow-up and returns
 * immediately, and the writer runs once more when the current write finishes —
 * so the latest state always reaches disk without one write per mutation.
 *
 * A rejected write propagates to its awaiter but never wedges the pipeline:
 * the in-flight flag resets in `finally`, so the next save starts a fresh
 * write. (The hand-rolled per-service predecessors skipped that reset on
 * rejection, after which every later save silently no-opped until restart —
 * see gaps/coalescing-save-wedge.md for the remaining adoptions.)
 */
export function createCoalescingSaver(
  write: () => Promise<void>,
): () => Promise<void> {
  let inFlight = false;
  let pending = false;

  const save = async (): Promise<void> => {
    if (inFlight) {
      pending = true;
      return;
    }
    inFlight = true;
    try {
      await write();
    } finally {
      inFlight = false;
      if (pending) {
        pending = false;
        await save();
      }
    }
  };

  return save;
}
