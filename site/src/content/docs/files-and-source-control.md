---
title: Files and source control
description: Review files and diffs remotely while keeping file access and Git mutations deliberately bounded.
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
shows working-tree changes, selected diffs, repository files, and recent
commits. Mutating actions are explicit:

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
