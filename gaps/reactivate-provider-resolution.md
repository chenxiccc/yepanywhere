# Reactivate guesses the provider for externally created sessions

The reactivate handler resolves the backend purely from YA's own launch record:

```
const providerName =
  (metadata?.provider as ProviderName | undefined) ??
  body.provider ??
  project.provider;
```

(`packages/server/src/routes/sessions.ts`, in the
`/projects/:projectId/sessions/:sessionId/reactivate` handler.)

A session YA did not launch has no `sessionMetadataService` record, so an
unqualified reactivate falls through to the *project's* default provider. For a
session created outside YA — started in the Grok TUI, say, inside a project
whose default is Claude — that reactivates the wrong backend against a native
session id the backend does not know.

The native session readers already identify the owning provider for these
sessions (`GrokSessionReader` and friends are imported into the same route
module for exactly that purpose), so the missing piece is using that fallback
here rather than a new mechanism.

The shared existing-session identity resolver and cross-provider coverage are
planned in
[`docs/tactical/104-provider-session-identity-and-reactivation.md`](../docs/tactical/104-provider-session-identity-and-reactivation.md).
This remains open until unqualified reactivation uses exact native evidence
instead of the selected project's default provider.

Found 2026-08-05 while replacing Grok's unstable `session/resume` with the
stable `session/load` path (see `topics/grok.md`).
