# Remote Executors do not run every provider

Settings now describes SSH hosts without Claude-specific copy, but runtime
support remains limited to the Claude-family adapters. The New Session chooser
is gated by `providerSupportsRemoteExecutors` in
`packages/client/src/lib/providerCapabilities.ts`; Codex, Gemini, Grok,
OpenCode, and Pi sessions cannot currently use a configured host. Before that
gate, those providers could retain an executor value while still launching
locally, which was worse than an explicit limitation.

Provider-neutral execution is larger than changing the chooser. Each adapter
needs a remote CLI/process launch contract, authentication and environment
handling, project-path translation, transcript synchronization, resume
identity, wake/debug routing, disconnect cleanup, and provider-host behavior.
Windows local-home translation also needs an explicit remote-platform mapping;
a backslash suffix cannot be assumed valid on a POSIX host.

Implement one provider end to end before advertising general support, and add a
provider capability rather than another client-maintained name set once remote
support can vary by server build or configuration.

Found 2026-08-20 while making Remote Executor settings provider-neutral.
