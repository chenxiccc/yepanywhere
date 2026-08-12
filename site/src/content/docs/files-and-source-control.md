---
title: Files and source control
description: Review files, Git history, and line comments remotely while keeping file access and repository mutations deliberately bounded.
---

Yep Anywhere turns file paths, edits, and repository state into reviewable
mobile and desktop surfaces. Remote convenience does not widen filesystem or
Git authority by default.

## File viewer

Open a linked path to view syntax-highlighted source, selected line ranges, and
supported Markdown media. The server checks the path against configured file
access roots before returning content.

Use **Settings → File access** to choose allowed roots such as project folders,
uploads, temporary files, the home directory, or a custom allow-list. Arbitrary
absolute paths are refused until their containing root is explicitly allowed.

Grant the narrowest roots that cover the workflow. A public session share does
not inherit authenticated project-file access.

## Diffs

Tool edits and source-control changes render as structured diffs. Wide screens
can use split views; phone layouts retain a readable single-column review.
Inspect the exact proposed change before approving or publishing it.

## Source Control page

The Source Control page is a review workbench, not a complete Git client. It
opens on the current working tree and can navigate recent commits and their
changed files. The **Files** view searches tracked paths and adds line-by-line
blame when provenance is available.

Click a line in a diff or blame view to leave a persistent review comment.
**Pending Comments** collects those notes across files and revisions; submit a
coherent bundle to a new or existing agent session when the review is ready.
**Reviews** retains the frozen submitted source, target session, follow-up
discussion, and resolution state so later review does not lose its history.

Repository-mutating actions remain deliberately narrow and explicit:

- **Check remote** fetches tracking state without modifying the working tree.
- **Pull** attempts a safe fast-forward and stops when changes diverge or would
  be overwritten.
- **Push** publishes completed work, including simple branch publication to
  `origin`.

The page does not silently merge, rebase, force-push, discard changes, or
resolve conflicts.

## Remote device control

Device control is an experimental but separate review surface. It streams
Android devices/emulators and iOS Simulators over WebRTC so you can inspect and
control an app from the browser. It is not the unpublished Yep Anywhere Android
client app.

Enable Device Bridge in Settings only when you need it. Real iOS devices are
not currently supported.
