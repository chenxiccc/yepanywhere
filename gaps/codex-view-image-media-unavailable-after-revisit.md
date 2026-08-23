# Codex ViewImage media becomes unavailable after revisiting a session

Revisiting a Codex session can leave historical `view_image` rows rendered as
`Image unavailable` even though the server can still rematerialize the image
bytes from the Codex transcript. This violates the on-demand media contract:
expired transient handles may disappear, but loading the session again should
rebuild them while provider persistence still contains the source image.

## Observed case

- Source server: `0.7.0-1053-g3f8288ab`.
- YA session: `01a02d45-4c60-70b0-a5dc-b1e056c60a25`.
- Provider: Codex.
- **Tool-result images**: **Load on demand** (`on-demand`).
- **Conversation View**: enabled, with a 240-user-turn history window.
- After returning to the session, the connected tab contained 16 tool-media
  previews whose rendered state was `Image unavailable` and no mounted media
  URL.
- A fresh session-detail response still reconstructed older `view_image`
  results as `stored`, including their original byte lengths and dimensions.
  Four consecutive results from the earlier visual-verification turn were
  present as two 1000x600 and two 375x812 PNGs. Codex had therefore not
  discarded those images.

The Conversation View summary is not sufficient explanation: the contract in
`topics/conversation-view.md` retains tool calls with media. The rebuild
contract is in `topics/session-media-handles.md`.

## Likely ownership and next check

The break is between rematerialization and the mounted media row, not proven to
be provider-history loss. Compare the media ids returned by session detail with
the URLs requested by
`packages/client/src/components/blocks/ToolResultMediaRows.tsx`, then check
whether `packages/server/src/media/ToolResultMediaStore.ts` evicts or replaces
the catalog entry before the row fetches it. Cover a
revisit/rematerialize/fetch sequence in the server media tests and the client
row test.

The required behavior is that every `stored` media descriptor returned for the
loaded transcript has a fetchable handle for the lifetime promised to that
view, or that the client can obtain a replacement after expiry. If a provider
truly no longer supplies the bytes, return the explicit unavailable state and
change the **Load on demand** setting copy to disclose that historical images
can disappear; do not use that explanation when rematerialization succeeded.

This was filed rather than fixed because the request was to preserve the
reproduced defect and current settings as a gap.

Found 2026-08-23 while revisiting a Codex session with tool-result images set
to Load on demand.
