# Native YA does not drop exec-time privilege escalation

The native server and provider launch paths contain no whole-process
`no_new_privs` setup. The Docker deployment supplies
`no-new-privileges:true`, but a directly launched YA server inherits the host
identity's ability to gain privilege. In particular, a provider child of a YA
user with passwordless sudo can invoke that same authority.

The policy choices, viable enforcement points, compatibility audit, and
verification plan are maintained in
[`docs/tactical/106-native-server-privilege-hardening.md`](../docs/tactical/106-native-server-privilege-hardening.md).
This gap remains open until native launches establish and report an effective
whole-process policy before agent-controlled children can run.

This is separate from session Project writes only confinement: it applies to
vanilla, non-sandboxed sessions too.

Found 2026-07-28 while designing session sandboxing.
