# Transport Message Admission

Topic: remote-hosted-compatibility

Status: Planned. The production direct server and public relay still admit a
single 100 MiB physical WebSocket message.

## Goal

Lower the worst-case physical WebSocket message admitted by every YA transport
without disconnecting supported client/server pairs that still send a complete
encrypted logical message as one frame.

The open evidence is tracked in
[`gaps/lower-websocket-message-admission.md`](../../gaps/lower-websocket-message-admission.md).
The governing compatibility and negotiated chunking contract is
[`topics/remote-hosted-compatibility.md`](../../topics/remote-hosted-compatibility.md).

## Current boundary

Format `0x05` limits negotiated response chunks to 256 KiB and uploads use
64 KiB application chunks. Those logical bounds do not yet permit a mechanical
parser-limit reduction: a relay cannot inspect end-to-end encrypted capability
negotiation, and supported stale peers can still deliver one complete frame.

The direct server, relay-facing client parser, and relay server parser must be
treated as one admission surface. Lowering only one creates route-dependent
failures that appear as transport instability rather than a clear compatibility
cutoff.

## Decisions required before implementation

- Define the supported stable-release corpus and the largest legitimate
  physical frame each client/server combination can emit.
- Choose whether the cutoff is a protocol-level change with a grace period or
  a limit that every supported peer already satisfies. A capability flag alone
  cannot protect an encrypted relay parser before the envelope is admitted.
- Select one physical-message ceiling with explicit allowance for envelope and
  framing overhead. Keep logical reassembly and upload limits separate.
- Decide what telemetry or representative traffic evidence is sufficient to
  show that legitimate messages do not approach the proposed ceiling.
- Specify the close code and user-visible diagnosis for an oversized message;
  do not leave the failure as a generic reconnect loop.

## Work plan

### 1 — establish the compatibility matrix

Exercise every stable peer pairing in the applicable horizon, including an old
client through the current relay and a current hosted client against an old
server. Record maximum physical frame sizes for large assistant output, file
uploads, and replay/catch-up.

### 2 — choose the rollout contract

If any supported pairing exceeds the proposed ceiling, define the previous
protocol grace path and update warning before enforcement. Otherwise document
why the reduction preserves all supported pairings.

### 3 — lower every physical parser together

Apply one shared limit to direct server, relay-facing client, and relay server
parsers. Preserve the independent 64 MiB logical-message reassembly bound and
negotiated application chunk sizes.

### 4 — prove direct and relay parity

Cover large assistant output, upload, catch-up, an authenticated oversized
input, and the stale-peer matrix. Verify bounded rejection, actionable client
copy, and no reconnect storm.

## Acceptance

- Every supported direct and relay pairing remains usable.
- All physical parser limits use the reviewed lower ceiling.
- Oversized authenticated input is rejected before unbounded buffering or
  parsing work and produces a stable, diagnosable outcome.
- The compatibility decision and cutoff/grace behavior are recorded in
  `topics/remote-hosted-compatibility.md` before enforcement lands.
