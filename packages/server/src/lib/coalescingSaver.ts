/**
 * Coalesce concurrent async saves onto one writer. At most one `write` runs at
 * a time; a save() issued while one is running marks a follow-up and returns
 * immediately, and the writer keeps draining until no follow-up is marked — so
 * the latest state always reaches disk without one write per mutation.
 *
 * A rejected write propagates to the awaiting caller (after any marked
 * follow-up has run — latest state gets its attempt either way; the last
 * failure wins) and never wedges the pipeline: drain state resets on the way
 * out, so the next save starts a fresh writer. (The hand-rolled per-service
 * predecessors skipped that reset on rejection, after which every later save
 * silently no-opped until restart.)
 *
 * Closure-based, so consumers that only save may bind the method:
 * `private save = createCoalescingSaver(() => this.doSave()).save;`
 */
export interface CoalescingSaver {
  save(): Promise<void>;
  /**
   * Resolves once no write is running or marked — quiescence, not success:
   * write failures are swallowed here (they surface to save()'s callers).
   */
  idle(): Promise<void>;
}

export function createCoalescingSaver(
  write: () => Promise<void>,
): CoalescingSaver {
  let draining: Promise<void> | null = null;
  let pending = false;

  const drain = async (): Promise<void> => {
    let failure: unknown;
    let failed = false;
    do {
      pending = false;
      try {
        await write();
      } catch (error) {
        failure = error;
        failed = true;
      }
    } while (pending);
    if (failed) throw failure;
  };

  const save = (): Promise<void> => {
    if (draining) {
      pending = true;
      return Promise.resolve();
    }
    const chain = drain().finally(() => {
      draining = null;
      // A save() can slip in between the drain loop's last pending check and
      // this cleanup; re-kick so its state is not stranded unsaved. Errors go
      // nowhere useful from a re-kick, so they are dropped (the state gets
      // rewritten by the next real save either way).
      if (pending) void save().catch(() => {});
    });
    draining = chain;
    return chain;
  };

  return {
    save,
    async idle(): Promise<void> {
      while (draining) {
        await draining.catch(() => {});
      }
    },
  };
}
