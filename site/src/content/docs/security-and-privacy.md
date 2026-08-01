---
title: Security and privacy
description: Understand what stays local, what crosses the public relay, and where website analytics and public shares differ.
---

Yep Anywhere is self-hosted software with optional network services. Security
claims depend on which surface you use.

## Local application data

Provider transcripts remain in provider-managed storage. Yep Anywhere keeps
server state—settings, logs, uploads, notification subscriptions, and session
metadata—in its local data directory. There is no hosted Yep Anywhere account
or hosted transcript database.

For npm and source installs, the default data directory is
`~/.yep-anywhere/` on macOS and Linux and
`%USERPROFILE%\.yep-anywhere\` on Windows. The desktop app keeps a separate
profile at `~/.yep-anywhere-desktop/` on macOS or
`%USERPROFILE%\.yep-anywhere-desktop\` on Windows. npm and source installs can
override their location with `YEP_DATA_DIR`.

Agent requests still go to the provider you configure. Local models keep that
provider path local; cloud providers receive prompts and tool context according
to their own product and privacy terms.

## Authenticated public relay

Normal remote access uses SRP authentication and end-to-end encrypted
application messages. The relay can observe connection metadata such as the
username, timing, and traffic sizes, but not authenticated session contents or
the password.

Use a long, unique remote-access password. Anyone who can authenticate receives
the authority exposed by your Yep Anywhere server.

## Public session shares

Public sharing is opt-in because it is not the same trust boundary as
authenticated relay access. No session is shared until its owner deliberately
creates a read-only link. A viewer with the secret link can read the shared
content until the share is revoked or live access ends. The current relay path
for public shares is not private from a relay operator: an operator who inspects
or modifies the relay can see the share request, bearer secret, and response
contents.

Review session contents before enabling a share. Revoke it when access is no
longer needed. Source Control is never exposed through the read-only share
namespace.

## File access

Remote file routes use explicit allowed roots. A linked path is not sufficient
authority by itself. Public-share file views are further limited to content
made visible by the share boundary.

## Website analytics

The public marketing, news, and documentation pages use Cloudflare Web
Analytics for aggregate visits, page paths, referrers, device classes, and
performance measurements. Cloudflare states that its Web Analytics product does
not collect or use visitors' personal data.

The hosted `/remote/` application does not include the marketing analytics
beacon. Prompts, files, approvals, and product actions are not sent as marketing
analytics events.

Read the complete [privacy policy](/privacy) for current network-service and
website disclosures.
