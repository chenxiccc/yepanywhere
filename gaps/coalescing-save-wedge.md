# Eleven services still carry the wedge-on-rejection save idiom

`createCoalescingSaver` (packages/server/src/lib/coalescingSaver.ts) owns the
coalesced-save pattern: one writer at a time, saves during a write collapse to
one follow-up, and a rejected write resets in-flight state in `finally` so the
next save starts fresh. The hand-rolled predecessors skip that reset — after
one rejected write (ENOSPC, EACCES, transient FS error), `savePromise` stays a
rejected promise forever, so every later save() marks `pendingSave` and returns
"success" without writing, silently losing all persistence until restart.

ReviewCommentService and PushService are converted. The same wedge shape
remains, verbatim, in:

- auth/AuthService.ts:334
- services/ServerSettingsService.ts:457
- metadata/ProjectMetadataService.ts:215
- metadata/SessionMetadataService.ts:708
- services/ModelInfoService.ts:188 (its flush loop at 177 also reads savePromise)
- services/NetworkBindingService.ts:310
- services/BrowserProfileService.ts:320
- services/BrowserProfileService — plus RecentsService.ts:177
- remote-access/RemoteAccessService.ts:253
- remote-access/RemoteSessionService.ts:489 (reset path at 159 also touches state)
- notifications/NotificationService.ts:183 (a loop-shaped variant; awaits the
  in-flight write before continuing — needs its own careful mapping)

The two index services (SessionIndexService, SessionDiscoveryIndex) already
reset via `.finally` and are not affected.

Cheap fix per service: replace the `savePromise`/`pendingSave` pair and the
`save()` body with `private save = createCoalescingSaver(() => this.doSave())`,
adapting the few that read `savePromise` elsewhere (flush/reset paths).
Do a few per commit with their tests; delete this file with the last one.

Found 2026-07-26 while fixing the same bug in ReviewCommentService (harsh-review
d050cdd3..6fe47847 blocker 1).
