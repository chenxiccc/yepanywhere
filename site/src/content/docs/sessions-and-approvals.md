---
title: Sessions and approvals
description: Start and resume sessions, supervise tool requests, steer compatible agents, and queue safe follow-ups.
---

The session view combines the user/agent conversation with tool activity,
approvals, diffs, files, usage, and delivery controls. Agents run on the server,
so browser disconnects do not by themselves stop active work.

## Start and resume

Use **New session** to choose a project, provider, model, permission mode, and
thinking controls. Existing compatible provider sessions appear in the session
inbox and can be opened or resumed with their history.

The inbox groups sessions by attention and activity so a waiting approval does
not disappear among recent but idle work. Star or archive sessions to keep the
working set useful.

## Choose the transcript detail

The full activity transcript preserves the conversation, every tool call, and
thinking when the provider makes it available. Expand individual tool and
thinking blocks when you need their detail.

Use **Conversation view** to condense routine activity into a calmer reading
flow. Collapsing a block or switching views changes only the presentation; the
underlying session detail remains available in the full activity transcript.

## Approvals and permission modes

When a provider asks to use a guarded tool, the session shows the proposed
action and available choices. Review paths, commands, and unsafe Unicode before
approving. Rejection returns control to the agent without pretending the tool
ran.

Permission modes are provider-dependent. More permissive modes reduce prompts
and increase risk; use them only in a project and environment where the agent
is allowed to make those changes.

## Steer, queue, and interrupt

- **Steer** sends guidance into a compatible active turn.
- **Queue** preserves a follow-up for delivery after the current turn reaches a
  safe boundary.
- **Interrupt** asks the provider to stop the active turn.

The UI reflects provider differences. A missing steering control does not mean
the app will silently emulate mid-turn delivery. Queued text is delivered
verbatim by default.

Use [Project Queue](/docs/project-queue) when work should wait for the entire
project—not merely the current session—to become quiet.

## Search, recaps, and activity

Session search helps locate older work. Recaps summarize bounded activity when
you return to compatible long-running sessions. The global activity view shows
what active agents are doing across sessions without requiring every transcript
to remain open.

## Fork and clone

Conversation forking and cloning are experimental and provider-dependent. A
clone copies through the latest completed response; a boundary fork copies a
completed prefix. The source session remains available. Actions are disabled
when a safe completed boundary does not exist rather than copying a partial
provider turn.

## Attachments

Attach screenshots, photos, PDFs, or code files from the composer. Uploads are
staged with the draft and materialized for the target session when sent. Review
the destination session before sending sensitive material.
