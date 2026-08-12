# User authorization attestations

> User authorization attestations are opt-in, gate-specific YA capabilities
> that carry one exact user approval or override into an agent session without
> making routine messages or inter-agent claims signature-dependent.

Topic: `user-authorization-attestation`

Status: sketch only. No signing key, UI, endpoint, capability directory,
attestation verifier, or signed gate is approved or implemented. The default
gate registry is empty.

The installed-agent consumption counterpart is
[graehl/agents user authorization attestation consumption](https://github.com/graehl/agents/blob/master/topics/user-authorization-attestation.md).
This topic owns YA issuance, transport, and threat boundaries; the agent topic
owns gate declaration and verified-claim consumption.

## Product boundary

The user would deliberately opt in for a specific turn after a governing
instruction had already named an attestation-required gate. Attestation is not
the default for user inputs and does not become a general priority system.

Outside a predeclared gate, agents continue ordinary research communication,
evidence checking, and provenance handling. In particular, one agent must not
reject another's research claim or account of user intent because it lacks a
YA signature. The lightweight advisor `[from ...]` interaction envelope is
also only routing provenance and remains unsigned by default.

## Signed-turn sketch

A deliberate YA UI action could ask the server to sign a canonical payload:

- protocol version and key id;
- stable gate id and exact authorized claim;
- scope and optional destination session/logical relation;
- hash of the exact user turn;
- optional stable ids and hashes—not full duplicate text—of recent turns to
  which the user responds;
- message id and issue timestamp; and
- an explicit statement of replay/freshness semantics, with no anti-replay or
  expiry by default.

The signature is content- and scope-bound rather than permission to reinterpret
nearby prose. Without anti-replay it is bearer-like for that exact claim;
timestamp and turn links provide audit context, not automatic rejection.

YA must never sign a submission merely because it arrived through the generic
`routes.post("/sessions/:sessionId/messages"...)` path. Otherwise an agent able
to call the local URL API could manufacture user-originated authorization. A
future signer needs a distinct, deliberate user-confirmed ingress and must keep
its private key outside provider-session reach. Transcript delivery may carry
the signed envelope, while `~/agents` supplies the public key and cheap
mechanical verifier.

Any UI should say which named gate, action, scope, and destination are being
authorized. A verifier failure or missing attestation at that gate should lead
to a visible issue/reissue or explicit fallback choice, not an unexplained
dead end. A valid user capability still cannot override system/developer
authority.

## Linux-bounded capability inbox

For local sessions, YA could instead place a canonical capability record in a
Linux-security-bounded inbox that the provider process can read but cannot
write. Atomic file creation and a cheap helper lookup may cost less than
signature delivery and verification.

This is a real alternative only when an OS boundary enforces it. A directory
owned by the same unconfined UID, even with conventional `0700`/`0600` modes,
does not stop that session from fabricating records. The existing
`session-sandboxing.md` work suggests the relevant shape: YA owns the write
side, while the provider receives a read-only bind or otherwise distinct
credential boundary. Unsupported providers and non-Linux hosts would need the
signed path or no attestation assurance.

The file and signature transports should normalize to the same gate id, claim,
scope, destination, and issue metadata. Gate rules then depend on verified
capabilities rather than one transport.

## Costs and adoption bar

Potential value is narrow: carry a particular user-owned authorization across
sessions or into an advisor/worker interaction without trusting copied prose.
Costs include UI and audit surface, key or sandbox administration, canonical
serialization, cross-provider delivery, verifier maintenance, transcript
tokens, and false confidence about a deliberately non-absolute boundary.

Do not implement until a concrete recurring gate cannot be served cheaply by
ordinary direct confirmation. At that point compare signed turns with the
Linux inbox on assurance, portability, durable replay/audit needs, and measured
token/tool cost. Reuse existing YA cryptographic and owner-only-path utilities
only after their trust directions are shown compatible; client-continuity
signatures in `security-client-audit.md` prove a client to YA, not a user's
authorization to an agent.
