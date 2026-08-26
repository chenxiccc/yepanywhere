# Codex View Image tool rows render twice

In running YA session `01a03f75-ca68-7282-8769-5ba4da94038f`, one image
inspection appeared as two consecutive, fully expanded **View Image** tool
rows. Both rows showed the same
`55887595-0226-4503-8efe-5202ea8d8570_image.png` name, `image` media label,
998x534 dimensions, and rendered bitmap. The user reports seeing this
duplication consistently rather than in this one transcript only.

This doubles the vertical space consumed by every inspected image and falsely
suggests that the tool ran twice. The leading hypothesis is a Codex-specific
projection defect because the observed tool is Codex code mode's `view_image`,
but the screenshot alone does not establish whether duplication originates in
the provider event stream, server normalization, session-detail projection, or
client render-item construction.

Start diagnosis at the Codex image-event normalization in
`packages/server/src/sdk/providers/codex.ts`, then compare the provider call id,
normalized tool-use/result pair, and final render-item identities before
changing `packages/client/src/components/renderers/tools/ViewImageRenderer.tsx`.
A regression fixture should submit one Codex `view_image` call and assert that
both the live stream and persisted reload contain exactly one visible tool row.
The completed rematerialization work in
`docs/tactical/114-codex-view-image-rematerialization.md` concerns unavailable
image bytes after reload, not duplicate rows.

This was captured rather than fixed because the user requested a gap entry and
the first divergent pipeline stage has not yet been demonstrated.

Found 2026-08-26 while viewing an attached comparison-table screenshot through
Codex code mode.
