# Resume reports "started" before the native session is actually attached

`POST .../sessions/:sessionId/resume` returns `resume.outcome: "started"`
(`packages/server/src/routes/sessions.ts:3945`) as soon as the supervisor hands
back a `Process`. For providers whose attachment happens inside the session
generator, that is earlier than it sounds: `GrokACPProvider.runSession` only
spawns the CLI and issues `session/load` when the iterator is first pulled, so
a load that fails — wrong id, deleted native session, CLI missing — is reported
after the route has already told the client the resume started.

The client therefore cannot distinguish "attached to the original native
session" from "process exists, attachment still pending or already doomed".
That distinction matters most for exactly the fail-closed case the Grok load
path now enforces: refusing to silently create a fresh session is only useful
if the caller learns the refusal promptly.

The provider-neutral attachment settlement and route behavior are planned in
[`docs/tactical/104-provider-session-identity-and-reactivation.md`](../docs/tactical/104-provider-session-identity-and-reactivation.md).
This remains open until resume can distinguish process admission from accepted
native-session attachment.

Found 2026-08-05 while replacing Grok's unstable `session/resume` with the
stable `session/load` path (see `topics/grok.md`).
