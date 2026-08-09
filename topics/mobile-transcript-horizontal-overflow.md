# Mobile transcript horizontal overflow

Status: **implemented.** The outer transcript clips inline overflow while
retaining vertical scrolling. Renderer-owned scrollers and turn image galleries
remain local exceptions rather than widening or moving the session viewport.

Related: PR [#90](https://github.com/kzahel/yepanywhere/pull/90), "Fix
horizontal page scroll on mobile chat view", opened by `joshtech90` and closed
on 2026-06-25 under the unsolicited-code-PR policy. The PR was not closed
because the bug report was invalid. The maintainer also reproduced the issue
with Codex Grep output causing a horizontal scrollbar.

## Symptom

On phone-sized session views, some sessions gain a horizontal scrollbar in the
outer transcript area. The scrollbar lands directly above the bottom composer,
where it can look like a broken fade/toolbar artifact. If the user swipes it,
the transcript content shifts sideways while the header and composer remain
fixed, leaving blank space or clipped message/tool rows.

This only appears in sessions whose transcript contains horizontally wide
content. Recent confirmed examples:

- Codex `Grep` summaries with long path/file names.
- Grep result previews and fixed-font tool rows.
- Long code/tool output that should scroll inside its own renderer box, not
  widen the whole transcript.

## Owning mechanism

`main.session-messages` is the vertical transcript scroller. Its base rule uses
`overflow: clip auto`: inline overflow is clipped at the session viewport and
block overflow remains the ordinary vertical scroll. This explicit two-axis
contract matters because `overflow-y: auto` with the horizontal axis left at
its initial `visible` value can compute to scrollable behavior on both axes.

There is already a related desktop/split-pane guard:

- `.session-split.session-split-with-aside > .session-messages` sets
  `overflow-x: hidden` and `min-width: 0` in the `min-width: 1100px` split-pane
  block.

Normal mobile sessions do not get that base-level guard. Candidate width
sources include Grep summary/path markup and any renderer whose min-content
width escapes its intended local scroller. In the July 2026 screenshots, the
visible offender was Grep output around a long
`mclone-quest-openxr-churn-...` path.

## Prior Patch

PR #90 proposed a four-line CSS fix in `packages/client/src/styles/index.css`:

- add `overflow-x: hidden` and `min-width: 0` to `.session-messages`;
- add `min-width: 0` to `.session-split`;
- add `min-width: 0` to the mobile `.message-list` content-width rule.

The rationale was that inner code/tool blocks already have their own
`overflow-x: auto`, so wide content should scroll locally instead of widening
the page. Treat this as the first experiment to re-evaluate, not as a
pre-approved patch: verify current renderer contracts before landing it.

## Diagnostic Value

The accidental outer horizontal scrollbar is useful while debugging because it
proves that a child renderer leaked min-content width past the intended
transcript column. Hiding horizontal overflow on `.session-messages` would
remove that obvious signal and could make a broken renderer silently clip
content.

That diagnostic value should not become the product behavior. The outer
transcript moving sideways breaks the session shell: header, composer, follow
controls, connection bar, and transcript content no longer share one viewport.
Prefer fixing the shell invariant while keeping a development/debug signal for
leaks, such as checking when `main.session-messages.scrollWidth` exceeds
`clientWidth` after render.

## Contract

The desired invariant is:

- the outer session transcript must not horizontally scroll at any viewport
  width;
- wide renderer content that genuinely needs horizontal movement should own a
  local horizontal scroller inside its row/card;
- turn image galleries may own horizontal touch scrolling without transferring
  that gesture or overflow to the outer transcript;
- header, transcript content, follow controls, connection bar, and composer
  must share one stable viewport alignment.

## Acceptance

- On a phone viewport, a session containing long Grep paths and long tool/code
  lines has no horizontal scrollbar on `main.session-messages`.
- Horizontal swipes do not shift the whole transcript away from the fixed
  header/composer.
- Local horizontal scrollers still work where they are intentional, especially
  code blocks and file/tool output previews.
- The bottom fade/connection-bar/composer boundary remains visually continuous
  when scrolled near, at, and away from the tail.
- Verify with a real mobile browser or in-app mobile shell; desktop emulation is
  useful but not sufficient for scrollbar/gesture behavior.
