# Unconfirmed sends can disappear across reload or server restart

A user saw a Smart Turn submission render as an `[ASR]` user bubble while the
session was busy, but no response followed and the message was absent after a
reload. The delivery-state marker was not observed, so the available evidence
cannot distinguish browser-local loss from server-accepted in-memory loss.

`SessionPage.handleSend` adds the pending bubble before uploads or the queue
request. `Process.queuePreparedMessage` emits a server-side optimistic echo and
returns queue success before its asynchronous steer attempt settles. Only the
matching provider transcript row proves durable delivery. Neither the
browser-local pending row nor the server's unconfirmed echo survives every
reload/restart boundary, and current diagnostics persist no receipt that can
identify the last completed boundary after the fact.

The fix belongs at the shared submission invariant, not in Smart Turn: retain a
submission receipt keyed by session and client temp ID until durable transcript
confirmation, then expose recovery or safe resend when confirmation never
arrives. If that changes the client/server wire contract, perform the required
stable-release capability review first.

Found 2026-08-10 while fixing mobile composer controls hidden by a software
keyboard.

## 2026-08-10 traced Codex incident

A later incident in session `019fe326-4499-79a1-8b8d-5935140e7efd` had enough
evidence to classify. A heartbeat resumed pending provider work. App-server's
`turn/start` response gave YA turn `019fea15-98e7-7e02-935c-0d9603630331`,
while Codex core's active turn was
`aaf3b4d3-f350-4d77-bd93-0a54642317d8`. Three user messages received optimistic
`sent` echoes, but steering was rejected by that ID mismatch and the messages
remained only in YA's process queue.

Stopping then exposed a second failure: the hard-abort path launched a
replacement before the retained app-server runtime had finished tearing down.
The replacement claimed the disappearing socket and failed with `ENOENT`,
stranding the three queued messages. The Codex adapter now adopts live
notification IDs and retries one rejected mismatch; hard-abort recovery now
waits for verified provider teardown before replacement ownership.

This explains the later typed-message cluster, but it does not close the
broader gap above. The earlier isolated Smart Turn/ASR observation still lacks
a durable receipt or trace proving whether the server accepted it.
