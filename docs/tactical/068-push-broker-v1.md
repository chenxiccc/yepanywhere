# Push Broker V1

Status: implemented and verified.

Topic: android-fcm-push

## Origin

YA needs native mobile notifications without requiring each self-hosted YA
server to hold credentials for the published Android app's Firebase project.
The approved architecture uses a small hosted push broker, while the Android
app and its authenticated YA server remain fully trusted with their paired
notification capability.

The first broker milestone is deliberately credential-free. It proves the
service boundary, persistence, capability authentication, abuse controls, and
provider adapter without contacting Firebase, changing the YA server/client
contract, or deploying a public service.

## Scope

Implement a standalone `@yep-anywhere/push-broker` TypeScript service with:

- Hono HTTP routes in a process separate from the relay;
- a private SQLite database and versioned schema;
- opaque installation and subscription identifiers;
- one-time installation-management and subscription-send secrets;
- SHA-256 verifiers for randomly generated 256-bit secrets;
- installation target replacement as the narrow seam needed by later FCM
  registration-lifecycle work;
- generic notification intents only;
- bounded, process-local fixed-window rate limits;
- an injected provider interface, a deterministic fake provider, and an FCM
  adapter tested without live credentials;
- structured logs that never include authorization secrets, delivery targets,
  or notification bodies; and
- health/readiness behavior and graceful shutdown.

The v1 broker routes are greenfield. This milestone does not add a YA server
route, client call, server capability, or compatibility-floor change.

## HTTP Contract

All mutation responses use `Cache-Control: no-store`. Defined JSON request
bodies are bounded to 8 KiB and reject unknown fields.

### Installations

- `POST /v1/installations` registers one current provider target and returns
  an opaque installation id plus an installation-management secret.
- `PUT /v1/installations/:installationId/target`, authenticated with the
  installation secret, atomically replaces the current target.
- `DELETE /v1/installations/:installationId`, authenticated with the
  installation secret, deletes the installation and all subscriptions.

The credential-free contract accepts FCM installation ids and legacy
registration tokens as opaque targets. Which target form the Android SDK uses
is not decided until the live Firebase milestone.

### Subscriptions

- `POST /v1/installations/:installationId/subscriptions`, authenticated with
  the installation secret, creates one server-specific subscription and
  returns its opaque id plus a one-time send secret.
- `DELETE /v1/installations/:installationId/subscriptions/:subscriptionId`,
  authenticated with the installation secret, revokes that relationship.
- `POST /v1/subscriptions/:subscriptionId/notifications`, authenticated with
  the send secret, submits one generic notification intent.

The send request cannot select or replace a provider target. Unknown,
revoked, and incorrectly authenticated capabilities return the same
not-found response.

### Generic Payload

The accepted intents are:

- `approval_required`;
- `input_required`;
- `session_completed`; and
- `session_failed`.

Every intent maps to the same conservative visible copy in this milestone:
`Yep Anywhere` / `Open Yep Anywhere for an update.` The provider data includes
only the intent and opaque subscription id. Descriptive/user-generated title
or body text is rejected.

## Conservative Limits

The first implementation uses configurable-in-test, process-local limits:

- 120 mutation requests per minute per source IP;
- 10 installation registrations per hour per source IP;
- 30 sends per minute per subscription;
- 120 sends per minute per installation; and
- at most 20 active subscriptions per installation.

Rate-limit maps are bounded and have no cleanup timer. They reset on process
restart; durable distributed quotas remain deployment work. Forwarded client
addresses are trusted only from explicitly configured proxy IPs/CIDRs.

## Failure Contract

- Invalid JSON, fields, target forms, or intents return `400`.
- Missing JSON content type returns `415`.
- Oversized bodies return `413`.
- Unknown or unauthorized capabilities return `404`.
- Exhausted subscription capacity returns `409`.
- Rate limits return `429` with `Retry-After`.
- Provider submission is awaited for at most 10 seconds. Timeouts and other
  retryable failures return `503`; rejected deliveries return `502`.
- Successful provider submission returns `202`. There is no durable queue,
  broker retry loop, or delivery guarantee in this milestone.

The service must fail startup if its provider is absent or invalid. The fake
provider is allowed only outside production. FCM mode requires an explicit
Firebase project id and uses Application Default Credentials, but no live FCM
mode is exercised in this milestone.

The standalone process binds to `127.0.0.1:4500` by default. Host, port, data
directory, provider timeout, log level, and trusted proxy ranges have explicit
`PUSH_BROKER_*` configuration. Deployment may override them; configured values
are authoritative.

## Verification

Credential-free verification must cover:

- schema creation, reopening, cascade deletion, and persistent revocation;
- constant-shape failure for unknown, revoked, and wrong-secret capabilities;
- stored-secret verifiers rather than plaintext credentials;
- inability for a send request to choose an arbitrary provider target;
- target replacement authorized only by the installation capability;
- exact generic-intent validation and rejection of descriptive content;
- subscription, installation, registration, and source-IP limits;
- trusted-proxy client-address handling;
- provider success, retryable failure, and rejection mapping;
- Firebase message mapping through an injected fake messaging client;
- request-body limits and safe error responses;
- logs free of secrets, delivery targets, and payload bodies;
- clean shutdown with no background timers; and
- local idle-memory measurement with the fake provider.

Before completion, run the package tests and repository lint without warnings,
plus the repository typecheck, build, and test commands.

## Stop Conditions

This milestone stops before:

- creating, selecting, or contacting a Firebase project;
- using Firebase service-account credentials or a real device target;
- implementing Android registration callbacks or refresh behavior;
- adding YA server storage/routes or Android client calls;
- conducting the required stable-release compatibility review for those
  future YA server/client contracts;
- enabling descriptive notification payloads;
- choosing durable quotas, provider retries, stale-target cleanup, or
  app-attestation policy; or
- configuring DNS, process supervision, secrets, or deployment.

## Follow-On Milestones

1. Configure a YA development Firebase project and prove a direct console
   notification reaches an Android test build.
2. Exercise the broker FCM adapter with credentials and a real target, then
   refine error and registration-lifecycle behavior from observed responses.
3. Present the required YA client/server compatibility plan and capability
   fallback before adding enrollment or send routes to installed YA servers.
4. Deploy the separately operated broker at `https://push.yepanywhere.com`
   only after its live-delivery and operational contracts are approved.

## Implementation Results

Completed on 2026-07-31:

- added the standalone TypeScript/Hono service and versioned SQLite schema;
- implemented one-time installation and subscription capabilities with only
  SHA-256 verifiers retained;
- added strict generic-only request validation, bounded bodies, capability
  rechecks around asynchronous work, and cascade/revocation behavior;
- added bounded source-IP, installation, subscription, and registration rate
  limits with trusted-proxy handling;
- added an injected fake provider and a lazily loaded Firebase Admin adapter;
- bounded HTTP and provider waits without adding a background loop or queue;
- made production reject the fake provider and made loopback the default bind;
  and
- kept YA server/client integration, live Firebase use, and deployment out of
  the change.

Verification:

- push broker tests: 44 passed without runtime warnings;
- Firebase FID/token message mapping exercised through an injected messaging
  client without loading credentials or contacting Google;
- package typecheck and build passed;
- repository lint passed with zero warnings;
- repository typecheck, build, and tests passed; the broad run retained its
  established intentional test diagnostics and Vite build advisories; and
- fake-provider idle measurement after a health request was approximately
  68 MiB RSS / 29.9 MB macOS physical footprint.
