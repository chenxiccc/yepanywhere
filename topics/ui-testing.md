# UI Testing

> Browser-first visual QA for client UI changes: a UI tweak request
> ends with rendered captures of the result at 1920×1080 and a phone
> width (375×812), inspected against the request before the change is
> called done.

Topic: ui-testing

## Principle

Any request that changes what the client renders — a UI tweak, layout
or spacing fix, control/toolbar placement, grouping, or interaction
semantics — is **done** only after real browser screenshots of the
final result are captured at desktop and phone widths, inspected by
the agent against the request, and archived where a human can review
them. In-progress captures are optional while implementing (worthwhile
at milestones); the final-result captures are not optional.

Inspection is the point: open each capture and check spacing, flow,
and control placement against the request — "route loaded, nav
visible" is not enough. Captures exist to catch the agent's own wrong
spatial/aesthetic guess; models routinely one-shot UI that is
functional but mis-spaced with misplaced controls (instituted
2026-07-26 after a commit-browser build landed exactly that way).

## Browser-first check protocol

1. Start the app UI and reproduce the target path in a real browser.
2. Navigate to the affected view (page, panel, or control).
3. Take screenshots at:
   - desktop width `1920x1080`,
   - narrow mobile width (`375x812` or equivalent).
4. Visually inspect each screenshot and confirm:
   - the requested change is present and correctly placed,
   - control rows and their descriptive text are grouped together,
   - active control state is visually clear,
   - no element overflows, crowds its row, or wastes obvious space.
5. Archive reviewed screenshots under a readable path (for example,
   `.artifacts/ui-testing/<yyyy-mm-dd>-<topic>/...`), and cite the
   file names in the final response (and the task note when one
   exists).
6. Leave a short reviewer note about what changed and what was
   visually confirmed.

## Recommended automation

Use the browser control tool listed in `CLAUDE.md` when it has an
available backend. If setup or discovery reports no browser, or the
browser inventory is empty, immediately fall back to the repository's
installed Playwright command:

```bash
ARTIFACT_DIR=".artifacts/ui-testing/$(date +%F)-topic"
mkdir -p "$ARTIFACT_DIR"
pnpm --filter @yep-anywhere/client exec playwright screenshot \
  --ignore-https-errors \
  --block-service-workers \
  --wait-for-timeout 500 \
  --viewport-size "1920,1080" \
  https://localhost:3400/ \
  "$ARTIFACT_DIR/desktop.png"
pnpm --filter @yep-anywhere/client exec playwright screenshot \
  --ignore-https-errors \
  --block-service-workers \
  --wait-for-timeout 500 \
  --viewport-size "375,812" \
  https://localhost:3400/ \
  "$ARTIFACT_DIR/mobile.png"
```

For multi-step flows, add or run a focused `@playwright/test` case under
`packages/client/e2e/`. If Playwright itself is unavailable, use another
browser automation path or a manual browser session:

1. Open the target page directly in a browser.
2. Resize viewport to desktop + mobile dimensions.
3. Capture screenshots via the tool or OS-level capture.
4. Attach the files where reviewers can review them directly.

## Verification acceptance checklist

- [ ] The requested change is visible and correctly placed in both
      captures.
- [ ] A single logical setting row does not span a control row and its
      status/explanation.
- [ ] A setting change has a matching explanatory text line directly
      below the control row.
- [ ] Preset buttons remain clickable and clearly indicate the current
      selection.
- [ ] Layout works at the mobile width without horizontal overflow.
- [ ] Screenshots at 1920×1080 and a phone width were captured,
      inspected by the agent, and cited for human review.
