# Background relay reconnect can leave a live session page blank

A hosted relay client was left in a background window while the user restarted
the local server. The old server began shutdown at 2026-08-26 22:39:19 UTC and
the replacement became healthy at 22:39:30. The affected client reconnected,
subscribed to session `01a03fcc-5d3f-7490-b35a-35802a10898a`, and fetched
incremental session detail by 22:39:52. It continued fetching that session at
22:40:53, 22:43:23, and 22:50:23, but the browser window remained blank until
the user manually reloaded it around 22:50:45. The reload immediately issued
full-history requests and restored the page.

This rules out replacement-server startup, relay pairing, exhausted reconnect
attempts, and an ordinary browser network-error document. The remaining defect
is an entire app-shell render dead-state while its route and session machinery
are still live; the user explicitly ruled out a transcript-only blank. The
window was not focused during the restart, so background visibility is a
plausible trigger but is not yet proven. The affected tab's explicit
browser-debug lease was memory-only and disappeared with the old server, so its
DOM and console state were unavailable after the report. The server log had no
client-error collection for the tab.

Current code does not route through a new connection gate or source identity
when the secure transport reconnects internally, so a generic DOM-linger park
is not supported by this trace. An isolated current-build direct-client server
replacement preserved the visible shell without a reload. An isolated hosted
relay attempt also captured a fully visible shell throughout a background
replacement outage, although that harness did not re-pair after the replacement
and therefore did not reproduce the observed connected-but-blank state. Do not
attribute this incident to session scroll restoration: that mechanism owns the
transcript viewport, not the surrounding navigation/header/composer shell.

Do not patch generic reconnect backoff for this incident: the transport did
recover. Reproduce with a hosted relay page kept hidden across a replacement
server restart, assert both continued session traffic and nonblank app-shell /
route DOM, and capture page errors, computed root/layer visibility and geometry,
the session-detail store snapshot, and the deployed client generation before
choosing the owning mechanism.

## 2026-08-27 direct-tab recurrence and diagnostic amplifier

An existing direct tab also remained entirely blank after `reyep --full` until
a manual browser reload; it showed neither the app frame nor `Loading...`.
Browser diagnostics had been enabled before the restart. After reload, the
authorized tab exposed a malformed version-1 `yep-anywhere-client-logs`
IndexedDB database with no object stores. Each attempted log write rejected,
and the global unhandled-rejection listener tried to persist that rejection
through the same broken store, producing thousands of recursive diagnostic
events. Disabling collection reduced event-sequence growth from thousands per
second to two events over the next two seconds.

ClientLogCollector now repairs the missing store through a version-2 upgrade,
validates the opened schema, catches asynchronous storage failures, and falls
back to its bounded in-memory buffer. This removes a demonstrated main-thread
and logging amplifier. It does not prove that the collector created the
pre-reload whole-shell blank state: the inspected DOM was already healthy after
manual reload, so this gap remains open for a trace captured before recovery.

Found 2026-08-26 while diagnosing a blank hosted session after manual server
reload.
