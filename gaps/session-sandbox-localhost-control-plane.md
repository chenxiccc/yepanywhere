# Session sandbox can escape through YA's localhost control plane

The Linux `project-write` backend starts Bubblewrap with `--share-net`
(`packages/server/src/session-sandbox.ts`) and the sandbox contract deliberately
permits outside-project reads. The confined provider can therefore connect to
the host's YA listener, normally `localhost:3400`. `X-Yep-Anywhere: true` is a
static request marker rather than a credential, and when local password/desktop
authentication is not enabled the API treats the request as authenticated.

That API can create an ordinary unsandboxed session, queue prompts, change
settings, and invoke other server-owned operations with the YA account's host
authority. A sandboxed agent can ask one of those paths to mutate outside its
project even though Bubblewrap correctly rejects the same direct filesystem
write. This violates `topics/session-sandboxing.md`'s requirement that the
agent-controlled domain have no inherited socket or other route to an
unsandboxed YA process acting on its behalf.

Missing fix: make privileged local YA/provider control surfaces unreachable or
authorization-safe from the sandbox. A valid design may isolate loopback/private
host networking while proxying only required provider egress, or authenticate a
narrow sandbox principal whose server-side authorization cannot exceed its
canonical project/session boundary. It must also hide provider-host/yacron
management sockets and credentials; merely omitting CLI instructions, PATH
entries, or a browser cookie is not a boundary.

Until that enforcement exists, YA must not advertise `project-write` as an
effective filesystem-integrity boundary against adversarial provider code. A
regression test must run inside the real Bubblewrap domain, prove that a
localhost attempt to create/control an unsandboxed session or cause an outside
write fails, and still demonstrate the provider network and allowed project
writes required by the supported mode.

Why not fixed in place: provider execution currently needs network access, so
closing this escape requires a network/IPC authority design rather than one
additional Bubblewrap flag or route check.

Found 2026-08-27 while defining yacron access for sandboxed sessions.
