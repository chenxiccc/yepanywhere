# Server Capability Sketches

> Candidate extensions to capability negotiation that are not part of the
> current compatibility contract.

Topic: server-capabilities

## Inferring a permanent withdrawal

The active protocol sends `deniedCapabilityBits` whenever a server must
exceptionally refuse a capability its version otherwise implies. There is no
current plan to add a version-implied capability that YA anticipates may be
withdrawn; `optional-bit` is the contract for experimental, removable, or
runtime-variable support.

If an unforeseen withdrawal later becomes permanent from a particular server
release onward, a future registry could record that negative version boundary.
Clients new enough to know it could infer the denial from `current`, just as
they infer introduction today, and servers new enough to know those clients
could omit that capability from routine `deniedCapabilityBits` traffic. Mixed
or older peers would retain the explicit negative bit. This is only a possible
compression of a settled withdrawal, not permission to model planned
variability as version-implied.
