# Native Server Privilege Hardening

Topic: session-sandboxing

Status: Policy and implementation boundary undecided. Container deployments
set `no-new-privileges`; a directly launched YA process does not.

## Goal

Prevent a native YA server and its descendants from gaining privileges through
`exec`, including in vanilla sessions where project-write sandboxing is off,
while preserving an explicit operator escape hatch for installations that
intentionally launch privileged helpers.

The open evidence is tracked in
[`gaps/native-server-no-new-privs.md`](../../gaps/native-server-no-new-privs.md).
The owning security contract is
[`topics/session-sandboxing.md`](../../topics/session-sandboxing.md).

## Why this is not a process-launch toggle

Linux `PR_SET_NO_NEW_PRIVS` is inherited by children, but it is established per
thread. Setting it late from JavaScript does not prove that every thread and
future child of an already-running Node process shares the restriction. It
also does not remove root identity, capabilities, or other privileges the
process already holds.

The enforcement point therefore has to be selected as product policy:

- a small native bootstrap can set the restriction before Node starts and
  re-exec YA;
- a service manager can establish it outside YA, but does not cover ordinary
  shell launches by itself; or
- per-child wrappers can protect provider children, but do not harden the
  server and are not equivalent to whole-process enforcement.

## Decisions required before implementation

- Choose the enforcement point and how YA verifies its effective state on
  every supported Linux launch path.
- Define behavior on non-Linux hosts and on Linux kernels or launch
  environments where the policy cannot be established.
- Decide whether enabled-but-ineffective hardening fails startup or permits a
  clearly reported degraded state.
- Audit update, sandbox, SSH, provider, browser, and operator helper launches
  for intentional `sudo`, setuid, or file-capability use.
- Define refusal or privilege-drop behavior when YA begins as root or with
  capabilities; `no_new_privs` alone is insufficient.
- Name the CLI, environment, and persisted configuration precedence for an
  explicit opt-out. Changing this deployment-sensitive default requires the
  hard-development-rules review before implementation.

## Work plan

### 1 — inventory native launch and exec paths

Map shell, service-manager, desktop/native wrapper, remote executor, update,
sandbox, and provider child paths. Classify which legitimately require an
exec-time privilege transition.

### 2 — prototype the earliest reliable enforcement point

Prove inheritance across Node workers and representative provider children.
Report the effective state from the running server rather than inferring it
from configuration.

### 3 — settle policy and compatibility

Choose default, opt-out, unsupported-host, root/capability, and failed-setup
behavior. Update the session-sandboxing contract before changing the default.

### 4 — implement and test launch parity

Cover direct shell, configured service, packaged/native, and child-provider
launches. Include a negative fixture that attempts a setuid or file-capability
transition and proves the kernel blocks it when hardening is effective.

## Acceptance

- Effective hardening is established before any agent-controlled child can
  launch and is observable through an operator-facing diagnostic.
- Enabled-but-ineffective state is never reported as hardened.
- Existing privileges are explicitly dropped or rejected according to the
  reviewed policy.
- The opt-out is explicit, documented, and distinguishable from an unsupported
  or failed enforcement attempt.
