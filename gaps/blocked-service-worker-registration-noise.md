# Blocked service-worker registration logs a TypeError

Playwright contexts created with `serviceWorkers: "block"` make
`navigator.serviceWorker.register()` return `undefined`. The
`registerServiceWorkerAtStartup` path in
`packages/client/src/lib/registerServiceWorker.ts` immediately reads
`registration.scope`, catches the resulting TypeError, and logs it as a failed
registration in otherwise healthy UI captures.

This is unrelated to the speech-prefix behavior and does not occur on the
normal browser registration path, so it was not folded into that change. A
focused fix should treat a blocked registration as an expected no-registration
result and cover the undefined return without weakening real registration
failure reporting.

Found 2026-08-22 while capturing the default speech-prefix settings UI with
service workers blocked.
