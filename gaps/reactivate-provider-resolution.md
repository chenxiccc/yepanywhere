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

Not fixed in place: the change belongs to the shared route/supervisor
reactivation path, which overlapped active server-performance work when this
was found, and it deserves its own coverage for each native reader rather than
riding along with a Grok adapter change.

Found 2026-08-05 while replacing Grok's unstable `session/resume` with the
stable `session/load` path (see `topics/grok.md`).
