# Remote browser diagnostics

> Remote browser diagnostics is an explicit 30-minute, per-tab lease that lets
> a YA-launched agent holding the pasted grant perform full JavaScript debugging
> against that connected tab through the YA server.

Topic: remote-browser-diagnostics

Status: implemented in the current source tree.

## Product contract

Remote browser diagnostics exists for failures that cannot be reconstructed
from server logs or a separate test browser. The target is one real tab with
its current DOM, client state, source binding, browser storage, console output,
and performance conditions.

The feature is deliberately absent by default. A capable client exposes
**Remote Browser Debugging** under the session-toolbar appearance settings. Its
setting uses the toolbar's normal **Hidden** and narrowing-priority values,
defaults to **Hidden**, and is stored in that browser rather than sent to the
server. Any non-hidden priority displays the inactive control and governs when
it moves into the toolbar overflow strip; changing priority never activates a
lease. A client connected to a server without
`remote-browser-diagnostics-v1` shows neither the setting nor the toolbar
control and makes no diagnostics request.

When shown, an inactive session bottom bar displays a bug glyph. Clicking it:

1. creates a lease for the canonical YA session id and a browser-session tab
   id;
2. starts tab-local console and performance collection;
3. copies an agent instruction containing the independent grant URL; and
4. replaces the bug with a red warning glyph and a circular countdown ring.

The confirmation banner begins exactly:

> Paste into a YA session to give full JS debugging access to this tab for 30m.

The copied instruction states the purpose, granted power, expiry, risk, and
commands. It can be pasted into any YA session launched by that server boot,
but conditions use by the present process on a non-printing preflight for both
injected browser-debugging variables. It forbids recovering missing credentials
from another process or file and explains that an older retained provider may
need a full wrapper/provider-host restart, a newly launched or resumed eligible
session, and a newly activated tab grant.

The instruction probes the installed CLI before treating it as usable. A
compatible response must contain the browser-debug-specific
`yepanywhere browser-debug info <grant-url>` usage line; a zero exit status or
generic top-level help is insufficient. A failed positive check is a CLI/server
generation mismatch rather than a rejected grant, and a session working in the
YA source checkout gets the current
`pnpm --filter server exec tsx src/cli.ts` fallback with the same positive
check. The bearer URL appears once and the example operations use a
placeholder. If clipboard writing fails, the lease remains visibly active and
the banner tells the user to disable and retry.

The active control's tooltip names the expiry time. Clicking it revokes the
lease. The control remains visible while active even if its stored toolbar
preference changes. Its timer turns it off at expiry. Navigation to a different
YA session turns it off after revocation is confirmed. A page hide makes a
keepalive revocation request. A new enable action creates new secrets; one
tab's grant never identifies or authorizes another tab.

The tab keeps a versioned session-storage revocation marker containing the
controller factor, source identity, session identity, and expiry, but not the
agent's grant secret. Enabling fails closed when that marker cannot be stored.
After a browser reload, the client immediately restores the red active warning
from the marker and attempts revocation against the originating source. It
clears the warning only after the server confirms revocation or reports that
the lease is already absent or expired. A transport failure leaves the warning
active so clicking it can retry; the warning clears locally at the server-side
expiry. Thus a reload cannot silently present an inactive control while an old
grant may remain reachable. A closed tab has no surviving marker owner, so its
page-hide revocation is best-effort and the server-side expiry remains the hard
backstop.

## Granted access

Version 1 intentionally grants full JavaScript evaluation in the connected
page. An authorized agent can inspect or mutate the DOM and application state,
read or change browser storage available to page JavaScript, issue same-origin
requests with the page's authority, and observe new console and performance
events. Evaluation can therefore change or break the tab and can disclose
sensitive content already available to that tab. The visible red control is a
warning, not merely a recording indicator.

The grant is not browser automation outside the page. It does not attach a
browser debugger, reach other tabs or origins, read browser-profile data that
page JavaScript cannot reach, dispatch privileged browser input, or execute an
operating-system shell in the tab.

Agents should explain evaluated code that may alter user-visible state. The
protocol does not mechanically enforce read-only evaluation in version 1.

## Two-factor authority

Possession of the pasted grant alone is insufficient. Agent-facing requests
need both:

- the per-tab grant secret copied in a
  `yep-browser-debug://<lease>?grant=<secret>` URL; and
- the current YA caller token injected only into provider processes launched
  by that YA server.

The agent CLI reads `YEP_BROWSER_DEBUG_AGENT_URL` and
`YEP_BROWSER_DEBUG_CALLER_TOKEN`; it refuses to run without them. The caller
factor is random for an ordinary Hono-owned server. Under reload-safe provider
hosting it is domain-separated from the random provider-host boot token, so
replacement Hono generations attached to that same host reproduce the factor.
Provider sessions receive only the derived factor; a caller-factor leak cannot
recover the provider-host token or gain provider-control authority. Local
directly launched provider sessions and newly launched hosted provider workers
receive the two exact browser-debugging variables through the existing
restricted agent-environment path. A remote executor gets them only when YA
already has an explicit child-reachable server base URL. The provider host
receives values as launch material, not a reusable general environment
pass-through.

For YA's local self-signed HTTPS mode, the agent URL carries the public
certificate as a URL-fragment trust anchor. The CLI removes the fragment before
the request and uses the certificate for ordinary TLS verification; it does not
disable verification or add a process-wide certificate exception. The
certificate is public material and neither authorization factor.

When a compatible local hosted provider worker survives Hono replacement, the
new generation re-publishes only these two allowlisted values through the
worker's atomic child-shell environment bridge. The factor remains valid
because its authority lifetime is the provider-host boot, not one replaceable
Hono generation. The present session therefore keeps access without restarting
the provider or interrupting its turn, including when a Codex sandbox omits the
shell bridge. The first deployment of this worker behavior still requires a
full wrapper restart; a source reload cannot teach an already running older
worker the new handshake. A full wrapper/provider-host restart changes the
factor and requires the provider session to be launched under the new host.

This proves possession, not an unforgeable process identity. A session that
leaks its current caller token weakens the YA-launch restriction for that
server boot; a pasted prompt or grant can also leak its tab authority. Short
expiry, independent factors, explicit revoke, loopback/host checking, and boot
rotation bound that risk. Neither factor should be printed in ordinary logs or
persisted as browser-diagnostics history.

The browser uses a separate controller token for polling, event upload,
evaluation results, and revoke. The copied instruction does not contain that
token. The server stores hashes of controller and grant secrets, returns 404
for a missing or mismatched lease factor, and offers no tab or lease enumeration
route.

## Broker and command interface

The ordinarily authenticated client routes are:

```text
POST   /api/browser-debug/leases
POST   /api/browser-debug/leases/:leaseId/poll
POST   /api/browser-debug/leases/:leaseId/results
POST   /api/browser-debug/leases/:leaseId/events
DELETE /api/browser-debug/leases/:leaseId
```

The host-checked agent routes require the current YA caller bearer token and
`X-YA-Browser-Debug-Grant`:

```text
GET  /browser-debug/v1/leases/:leaseId
GET  /browser-debug/v1/leases/:leaseId/events?after=<sequence>
POST /browser-debug/v1/leases/:leaseId/eval
```

The local CLI supplies both factors automatically:

```text
yepanywhere browser-debug info <grant-url>
yepanywhere browser-debug events <grant-url> [--after <sequence>] [--follow]
yepanywhere browser-debug eval <grant-url> <javascript>
```

`info` establishes which canonical YA session and per-tab identity the grant
represents. `events --follow` tails the in-memory event sequence. `eval` admits
only one pending evaluation per lease and waits for the browser's poll loop to
execute it. The browser executes the explicitly granted source through a
short-lived inline script bridge, which works under YA's served-page policy
without granting the page general `unsafe-eval`/`Function` compilation. It
first preserves expression completion values (including promises), then
accepts statement bodies with `undefined` completion; mutations and thrown
errors cross the same result bridge. The injected script element and its
temporary global result slot are removed after each command.

The server is a memory-only rendezvous. Restarting Hono invalidates every lease.
An ordinary Hono-owned restart also changes the caller factor; a reload-safe
replacement retains the provider-host-derived factor, but has no retained tab
grant to use. The server never sends an unsolicited command to a browser and
runs no lease heartbeat or cleanup loop; browser polls are bounded long polls,
and expired entries are removed on use or before admitting another lease.
Successful client revocation returns a JSON confirmation so every source
transport can distinguish confirmed deletion from a response-decoding failure.

## Collected evidence and bounds

Collection begins only after enable and restores every wrapped browser API on
disable. Version 1 records:

- `console.debug`, `error`, `info`, `log`, and `warn` calls made while active;
- uncaught window errors and unhandled promise rejections;
- delayed editable-control key dispatch and next-animation-frame latency;
- animation-frame gaps of at least 100 ms and supported browser long tasks;
- five-second visibility, DOM-element-count, and JavaScript-heap samples; and
- explicit app annotations sent through `window.__YA_BROWSER_DEBUG_EMIT__`.

This is not historical console access. It sees only events after enable.
Key receipt and animation-frame delivery use `performance.now()` at both ends,
so their elapsed value is non-negative and does not mix the animation
callback's frame timestamp with callback receipt time. Frame-gap collection
clears its baseline whenever document visibility changes and suppresses the
first new foreground frame, so hidden time is not reported as main-thread
starvation.
Values are cycle-safe, depth- and collection-bounded, and long strings are
truncated. The browser batches at most 100 events per request and retains at
most 500 unsent events. The server admits at most 32 active leases, retains at
most 1,000 events and 2 MiB per lease, limits event/result request bodies to
256 KiB, limits evaluated source to 128 KiB, and expires evaluations after 60
seconds. These are abuse and memory bounds, not promises to preserve every
diagnostic event under overload.

## The composer-delay hypothesis

The motivating observation is second-plus interruption of typing when the
conversation view processes session activity. That observation is accepted;
the proposed cause remains unproven. Frame starvation, long tasks, excessive
inbound updates, repeated transcript work, DOM growth, and unrelated host or
transport stalls can look similar.

The first diagnostic pass should tail events, reproduce ordinary typing, and
correlate `composer.keystroke-latency`, frame gaps, long tasks, DOM/heap samples,
and server-side session traffic. Remote diagnostics provides visibility; it
does not itself throttle conversation rendering or establish a performance
fix. Render/backpressure decisions remain governed by
[`conversation-view.md`](conversation-view.md) and the existing client
performance task.

## Compatibility

`remote-browser-diagnostics-v1` is global capability ID 31, introduced in
0.7.1, permanent, and version-implied. Source builds whose displayed version
does not yet imply 0.7.1 send the allocated positive ID. Stable servers 0.7.0
and 0.6.2 have none of the routes above; the absent-capability behavior is to
hide both surfaces and make zero requests. Existing capability meanings and
older capable behavior are unchanged.

An exceptional server denial in `deniedCapabilityBits` overrides version
implication. This feature is not intended to vary by host or configuration;
such a future replacement would need an `optional-bit` capability rather than
silently changing this one.

## Possible narrower successors

A later interface may add typed, read-only snapshots for app state, semantic
DOM, accessibility, logs, or screenshots. Masking and per-operation scopes
would make that suitable for grants that should not permit mutation. A
separately installed Chromium extension could expose browser-owned performance,
accessibility, or network facts through an allowlist rather than raw Chrome
DevTools Protocol passthrough.

Those designs would use new capabilities and explicit scopes. They do not
weaken or ambiguously redefine the deliberately full-access v1 contract.

## Observable checks

- A default browser profile shows no remote-debug toolbar control.
- Choosing **Show** makes the bug control appear only against a capable server.
- Enabling copies the documented instruction and shows a red countdown for no
  more than 30 minutes.
- A grant without the current YA caller token is denied.
- A caller token without the per-tab grant is denied and cannot enumerate tabs.
- Correct factors can read post-enable events and complete one JavaScript
  evaluation through the enabled tab under YA's served-page CSP, without
  adding `unsafe-eval`.
- The copied instruction rejects generic top-level help as a compatible CLI.
- Key-to-frame delays are non-negative, and background time is absent from
  foreground frame-gap events.
- Local self-signed HTTPS supplies its public certificate through the agent URL
  fragment and the CLI verifies the broker with that certificate.
- A compatible local hosted session retained across Hono replacement publishes
  the provider-host boot's two allowlisted debugging values to later Bash tool
  shells, while its launch-time factor remains valid through the replacement.
- Explicitly confirmed revoke, expiry, session navigation with confirmed
  revoke, or server restart prevents further grant use.
- Reload shows the active red warning before attempting to revoke the retained
  lease marker; failed revocation leaves that warning active until retry or
  expiry.
- Connecting the same client to 0.7.0 or 0.6.2 exposes no control and sends no
  browser-debug request.
