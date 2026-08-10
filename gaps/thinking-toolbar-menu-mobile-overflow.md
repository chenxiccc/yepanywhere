# Thinking toolbar menu clips against the phone viewport

At 375×812, opening the composer thinking menu from
`packages/client/src/components/MessageInputToolbar.tsx` places its right edge
past the viewport, clipping the menu border and shadow. The positioning and
width rules live in `packages/client/src/styles/index.css` near
`.thinking-toolbar-menu`.

This was not fixed during the Codex sticky-effort repair because that change is
server-side behavior and the mobile positioning fix requires the client CSS
ownership/extraction workflow. A likely bounded fix is to constrain or flip the
menu's inline position at narrow widths, then move the owned legacy rules into a
co-located module and verify both toolbar variants.

Found 2026-08-10 while visually verifying active-turn effort selection.
