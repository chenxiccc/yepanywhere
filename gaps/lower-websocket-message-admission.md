# Production WebSocket admission remains at 100 MiB

Negotiated response chunks now carry at most 256 KiB plus framing, uploads use
64 KiB application chunks, and the isolated relay browser fixture passes with a
1 MiB WebSocket parser limit. Production still retains the historical 100 MiB
allowance in `packages/server/src/websocketLimits.ts` and
`packages/relay/src/config.ts` because supported stale clients and servers may
send one complete encrypted frame and the relay cannot inspect their capability
negotiation.

A lower allowance would tighten worst-case message buffering, parsing work, and
malicious authenticated input. The compatibility decisions, rollout boundary,
and verification work are maintained in
[`docs/tactical/105-transport-message-admission.md`](../docs/tactical/105-transport-message-admission.md).
This gap remains open until that plan establishes and lands a lower limit
across every direct and relay parser.

Found 2026-08-06 while adding negotiated large-message transport chunks.
