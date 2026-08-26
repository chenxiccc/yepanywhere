# Public-share status polling still wakes large session pages

While public sharing is enabled, `usePublicShareStatus` and
`usePublicSessionShareStatus` each poll on a five-second timer. Both hooks
avoid publishing unchanged successful responses, but every poll still performs
the request and JSON parse on the session page. A 2026-08-26 browser trace of a
45,103-message Codex session found otherwise-stable 100--200 ms main-thread
pulses aligned with the 82-byte per-session and 459-byte global status
responses, while `MessageList` itself committed only 12 times for 165 ms total
over 5.8 minutes.

Before changing the timers, profile the request settlement path to distinguish
JSON/network overhead from downstream client-query or page reconciliation.
Then remove the avoidable wake-up at its owner while preserving prompt viewer
counts, reconnect refresh, and sharing-state changes. This was not fixed with
the adjacent transcript-rendering retirement because it has a separate polling
and freshness contract.

Found 2026-08-26 while diagnosing a long-session reload with browser-debug
performance events.
