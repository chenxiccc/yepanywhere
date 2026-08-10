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
