# Native YA does not drop exec-time privilege escalation

The native server and provider launch paths contain no whole-process
`no_new_privs` setup. The Docker deployment supplies
`no-new-privileges:true`, but a directly launched YA server inherits the host
identity's ability to gain privilege. In particular, a provider child of a YA
user with passwordless sudo can invoke that same authority.

Add default-on, operator-configurable startup hardening independent of session
sandbox selection. On Linux, establish `PR_SET_NO_NEW_PRIVS` before any
provider or agent-controlled child can run, expose the effective state, and
fail startup if the enabled policy cannot be established. An explicit
CLI/environment/config opt-out may retain current behavior, but must not be
reported as hardened. Starting as root or with capabilities needs an explicit
drop/refusal policy because `no_new_privs` does not remove privileges already
held. Audit legitimate YA subprocesses and any future privileged sandbox
helper before choosing the exact startup point.

This is separate from session Project writes only confinement: it applies to
vanilla, non-sandboxed sessions too.

Found 2026-07-28 while designing session sandboxing.
