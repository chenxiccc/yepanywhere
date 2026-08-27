# YA cannot take a consistent live full-state backup

YA has no supported operation that creates a restorable, self-describing
snapshot of its full durable state while the server and provider host remain in
use. Copying the configured data directory recursively can mix revisions from
independent writers, omit provider-native or opted-in project-local state, and
capture transient runtime files without proving that queued work or scheduled
prompts can be recovered.

Missing feature: add one server-coordinated backup operation with a defined
point-in-time boundary. It must checkpoint or briefly quiesce every
authoritative mutable store, enumerate all included roots and schema versions,
and produce a manifest with integrity evidence. Accepted mutations belong
entirely before or after the boundary; a backup must not contain half of a
cross-store update.

The restore contract must preserve canonical YA session identities, settings,
metadata, durable queues, yacron entries/occurrences/receipts, and retained user
assets. It must explicitly classify provider-native transcripts and
credentials, browser/device-only state, and project-local YA state as included,
externally backed up, or excluded; an export that omits one of those categories
must not call itself a full YA-state backup. Disposable caches and live sockets
should be regenerated rather than archived.

The snapshot should be possible while YA remains generally available, even if
the point-in-time barrier briefly pauses mutations. Creation, verification, and
restore need cross-platform behavior and a user-selected destination outside
the state being captured.

Why not fixed in place: this requires a complete store inventory and a shared
checkpoint/restore protocol across server, provider-host, yacron, provider, and
optional project-local owners.

Found 2026-08-27 while defining yacron restart and machine-loss recovery.
