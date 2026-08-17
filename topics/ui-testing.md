# UI Testing

> Browser-first visual QA is the default for client UI changes: capture
> and inspect the result at 1000×600 and a phone width (375×812), one image
> at a time, unless the user explicitly takes ownership of visual verification
> or asks to skip screenshots or visual validation.

Topic: ui-testing

## Principle

By default, a request that changes what the client renders — a UI tweak,
layout or spacing fix, control/toolbar placement, grouping, or interaction
semantics — is **done** only after real browser screenshots of the final result
are captured at desktop and phone widths, inspected by the agent against the
request, and archived where a human can review them. In-progress captures are
optional while implementing (worthwhile at milestones); final-result captures
are required when visual verification remains agent-owned.

Inspection is the point: read and inspect captures sequentially, one image per
tool call, and finish the notes for one before reading the next. Never batch
multiple images into one read. Check spacing, flow, and control placement against
the request — "route loaded, nav visible" is not enough. Captures exist to catch
the agent's own wrong spatial/aesthetic guess; models routinely one-shot UI that
is functional but mis-spaced with misplaced controls (instituted 2026-07-26 after
a commit-browser build landed exactly that way).

## User-owned visual verification

The user may explicitly take ownership of visual verification for a request or
a stated iteration series. Phrases such as "I will check it," "no screenshots,"
or "skip visual validation" are an intentional handoff, not a conflict with
this topic.

When the user makes that handoff:

1. Do not capture screenshots or launch a browser solely for visual QA.
2. Continue relevant nonvisual checks such as lint, typecheck, and focused
   automated tests unless the user also changes that scope.
3. Do not infer or report that the result was visually confirmed by the agent.
   State in the final response that visual verification was left to the user.
4. Do not wait for the user to report back before handing off the implemented
   change; their explicit acceptance of the visual check completes the agent's
   visual-QA responsibility.

Apply the handoff only to the scope the user stated. A handoff for an iteration
series may persist across its related tweaks, but do not silently carry it into
an unrelated request or a new session. Conversely, do not infer a handoff from
the user's presence, response speed, device, or presumed access to a live
build. When there is no explicit handoff, use the default capture workflow.

## Browser-first check protocol

1. Confirm that the user has not handed visual verification off to themselves.
   If they have, use the user-owned workflow above and stop this protocol.
2. Start a fresh dev-server process from the current worktree on an unused
   port; do not reuse an already-running process. Use a disposable data
   directory when isolation is needed to avoid disturbing the user's live
   server. When launching that server, set `VITE_DISABLE_ONBOARDING=true` and
   `VITE_DISABLE_CLI_UPDATE_NOTIFICATIONS=true` so first-run and CLI-update
   dialogs cannot obscure the surface under test. These are Vite startup
   inputs; setting them only on the later screenshot command has no effect.
3. Navigate to the affected view (page, panel, or control).
4. Take screenshots at:
   - desktop width exactly `1000x600`,
   - narrow mobile width exactly `375x812`.
   Read and inspect the desktop image alone and finish its notes before reading
   the mobile image. Never pass multiple images to one image-reading call.
5. For each screenshot, confirm:
   - the requested change is present and correctly placed,
   - control rows and their descriptive text are grouped together,
   - active control state is visually clear,
   - no element overflows, crowds its row, or wastes obvious space.
6. Archive reviewed screenshots under a readable path (for example,
   `.artifacts/ui-testing/<yyyy-mm-dd>-<topic>/...`), and cite the
   file names in the final response (and the task note when one
   exists).
7. Leave a short reviewer note about what changed and what was
   visually confirmed.

Any capture containing the `Server changed` banner or another stale-runtime
indicator is invalid. Restart from the current worktree and recapture rather
than treating the banner as unrelated visual noise.

## Recommended automation

Use the browser control tool listed in `CLAUDE.md` when it has an
available backend. If setup or discovery reports no browser, or the
browser inventory is empty, immediately fall back to the repository's
installed Playwright command:

Launch the fresh dev server in its own shell with the overlay suppressions:

```bash
VITE_DISABLE_ONBOARDING=true \
VITE_DISABLE_CLI_UPDATE_NOTIFICATIONS=true \
pnpm dev
```

Once that server is ready, capture from another shell:

```bash
ARTIFACT_DIR=".artifacts/ui-testing/$(date +%F)-topic"
mkdir -p "$ARTIFACT_DIR"
pnpm --filter @yep-anywhere/client exec playwright screenshot \
  --ignore-https-errors \
  --block-service-workers \
  --wait-for-timeout 500 \
  --viewport-size "1000,600" \
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

Read and inspect `desktop.png` alone and finish its notes before making a
separate image-read call for `mobile.png`.

For multi-step flows, add or run a focused `@playwright/test` case under
`packages/client/e2e/`. If Playwright itself is unavailable, use another
browser automation path or a manual browser session:

1. Open the target page directly in a browser.
2. Resize viewport to desktop + mobile dimensions.
3. Capture screenshots via the tool or OS-level capture.
4. Attach the files where reviewers can review them directly.

## Verification acceptance checklist

Complete either the agent-owned or user-owned branch.

### Agent-owned visual verification

- [ ] The requested change is visible and correctly placed in both
      captures.
- [ ] A single logical setting row does not span a control row and its
      status/explanation.
- [ ] A setting change has a matching explanatory text line directly
      below the control row.
- [ ] Preset buttons remain clickable and clearly indicate the current
      selection.
- [ ] Layout works at the mobile width without horizontal overflow.
- [ ] Screenshots at 1000×600 and 375×812 were captured, read one image at a
      time, inspected by the agent, and cited for human review.

### User-owned visual verification

- [ ] The user explicitly took ownership of the visual check or asked
      to skip screenshots or visual validation.
- [ ] No browser or screenshot work was performed solely for visual QA.
- [ ] Relevant nonvisual verification still ran unless separately waived.
- [ ] The final response identifies visual verification as user-owned
      and does not claim independent visual confirmation.
