# User Authorization Attestations

> User authorization attestations are not implemented: YA does not sign,
> store, transport, or verify a stronger class of user turn for agent gates.

Topic: user-authorization-attestation

Status: current absence and authority boundary. The dormant signature and
capability-inbox designs are preserved in
[`user-authorization-attestation.sketches.md`](user-authorization-attestation.sketches.md).

## Current contract

YA has no attestation key, signed-turn UI, gate registry, capability inbox,
verification endpoint, or attestation-aware provider message format. The
default gate registry is empty. Ordinary user messages remain ordinary user
messages under the provider's existing authority model.

In particular, receiving a message through the authenticated generic session
message route does not prove a special, gate-specific human authorization.
Agents must continue to apply their governing confirmation and provenance
rules. Inter-agent descriptions of user intent and lightweight advisor
envelopes are not rejected merely because they lack a YA signature.

No valid user-controlled feature can override system or developer authority.
YA also makes no operating-system assurance that an unsandboxed provider
process sharing the server's user identity cannot fabricate a same-user file.

The installed-agent counterpart remains
[graehl/agents user authorization attestation consumption](https://github.com/graehl/agents/blob/master/topics/user-authorization-attestation.md).
That document cannot make YA attestations available while this issuance
surface remains absent.

## Boundary for future work

Do not implement attestation until a concrete recurring gate cannot be served
by ordinary direct confirmation. The candidate signed payload, deliberate
user ingress, key isolation, Linux-bounded inbox alternative, portability
trade-offs, and adoption bar live only in the sketches companion. They are not
an approved protocol or permission surface.
