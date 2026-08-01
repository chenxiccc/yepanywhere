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

Public shares are deliberate read-only links, but they are not the same trust
boundary as authenticated relay access. A viewer with the secret link can read
the shared content until the share is revoked or live access ends. The current
relay path for public shares is not private from a relay operator.

Review session contents before sharing. Source Control is never exposed through
the read-only share namespace.

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
