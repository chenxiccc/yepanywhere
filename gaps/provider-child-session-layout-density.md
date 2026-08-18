# Read-only provider subagent pages waste vertical prelude space

The nested provider-child route keeps all useful context, but presents it as two
stacked headers: `ProviderChildSessionPage` owns a full-width **Back to parent
session** bar, then `ProviderChildSessionDetail` stacks the child title,
agent/status/depth metadata, and read-only explanation above the transcript.
The supplied capture shows that this prelude consumes a disproportionate share
of a short viewport before any child content appears.

## Requested outcome

Keep every current piece of information while making the prelude
layout-efficient:

- compose the parent-session link into the shared child-detail title area rather
  than reserving a page-only header row;
- when the child-detail container is wide, arrange identity, the read-only
  explanation, and actions/context as columns;
- keep a clear stacked layout when the component itself is narrow, including
  phone widths and the managed-detail window; and
- preserve the absence of a composer and the canonical parent session URL.

Acceptance includes real-browser captures at exactly 1000×600 and 375×812,
inspected sequentially, showing materially more transcript above the fold with
no crowding or horizontal overflow.

## Current state and crux

No implementation files were edited. Work paused because the active Source
Control session `9e49087a-3646-467b-9d8d-4ec4151e7800` claimed broad overlapping
`packages/client/src/pages` and `packages/client/src/components` scope. The user
asked this session to wait for explicit clearance rather than resume when that
claim disappears.

The shared title boundary is `ProviderChildSessionDetail`, used both by the
nested page and the managed child viewer. The page should supply its parent link
through that boundary's existing `actions` slot instead of retaining a separate
header. A container-responsive grid is preferable to a viewport breakpoint
because the same component can occupy either a full page or the detail column
beside the managed viewer's child selector.

The mapped implementation is:

1. In `packages/client/src/pages/ProviderChildSessionPage.tsx`, remove the outer
   header and pass the existing parent `Link` as the detail's action/context.
   Delete the obsolete header rules from
   `ProviderChildSessionPage.module.css`.
2. In `packages/client/src/components/ProviderChildSessionDetail.tsx`, group the
   title and metadata as the identity column while retaining the read-only copy
   and `actions` as separate title-area regions. Consider a heading-level prop
   so the full page has an `h1` while the managed window keeps an `h2`.
3. In `ProviderChildSessionDetail.module.css`, stack those regions by default
   and use a container query to place identity, read-only context, and actions
   in columns only when the detail container has enough intrinsic width.
4. Extend
   `packages/client/src/pages/__tests__/ProviderChildSessionPage.test.tsx` to
   assert that the parent link and child heading share one header/title area,
   while retaining the read-only/no-textbox assertions.
5. Update `topics/provider-child-sessions.md` § Presentation contract with the
   observable title-area and responsive-layout rule.

Relevant existing contract: `topics/provider-child-sessions.md`, especially
lines 93–109. The original supplied screenshot is
`/home/graehl/.yep-anywhere/projects/b683b7dd7578c6aadbf5d0d5fa6562e8/attachments/1744622b-4ea8-47a9-82d3-9b530d0d7925/98fdc823-244e-4bdb-81aa-b195eaee440f_image.png`.

## Resume and verification

Do not build until the user explicitly says the overlap is clear. On clearance,
run `agentctl others 09f1d969-0069-4c6e-911c-9ed91c6afc00`, reread each target
file immediately before editing if any peer remains, and stop on a genuine
scope overlap.

After implementation, run the focused client test through the package runner,
format only the exact edited files, and run the client CSS/touched checks,
lint, typecheck, console scan, and relevant end-to-end coverage. Start a fresh
isolated dev server with the UI-testing overlay suppressions for the required
1000×600 and 375×812 final captures. Delete this gap in the commit that lands
the fix.

Found 2026-08-18 while planning the requested read-only provider subagent layout compaction.
