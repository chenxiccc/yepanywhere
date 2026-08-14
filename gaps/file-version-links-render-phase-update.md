# File version links update React state during render

Expanding the live tab from Conversation View into the full transcript emitted
React's warning:

> Cannot update a component (`FileVersionControlLinks`) while rendering a
> different component (`FileVersionControlLinks`).

`packages/client/src/components/FileDiffViewLinks.tsx:46` mounts the link for
file-bearing Read/Edit rows. Its `useFileVersionControl` path combines retained
client queries, Git status, and route-retention subscriptions. Bulk mounting
those rows is therefore a current reproducer, but the exact setter responsible
has not yet been isolated.

Add a regression that mounts several version-link instances while their shared
query/retention state changes, identify the render-phase publisher, and move
that publication to the store owner or a post-commit effect. Suppressing the
warning would leave the invalid update ordering and possible excess churn.

It was not fixed during the capture because the live tab could not be safely
hot-reloaded and remote evaluation was unavailable under the current CSP.

Found 2026-08-14 while switching a live session out of Conversation View.
