# Accepted Codex steering row scrolls out of the live view

During an active Codex turn, YA accepted the steering message
`oh i think you are interp the diff as being between HEAD^1 and HEAD. actually i
prefer cumulative diff HEAD^1 and worktree.` The mounted session appeared not
to show the sent row, while reload restored it in the correct session.

Provider delivery and durable replay are healthy. The Codex rollout persisted
both the `response_item` user message and `event_msg.user_message` at
`2026-08-10T03:04:47.556Z`. A focused `MessageList` reproduction also keeps the
steer row in the DOM before and after the next thinking update. The defect is
viewport follow, not a missing live or durable message.

The reproduction starts with expanded streaming thinking, adds a pending steer
and increments `scrollTrigger`, replaces the pending row with the confirmed
user row, then grows the next thinking block. The send correctly moves a
500-pixel viewport to `scrollTop = 500` for 1,000 pixels of content. When the
next thinking delta grows the content to 1,400 pixels, the confirmed steer is
still in the DOM but `scrollTop` remains 500 instead of following to 900. This
matches the observed trace: the first post-steer reasoning update arrived 5.9
seconds after acceptance, followed by commentary and tool activity that could
move the steer above the viewport. Reload rebuilds the compact Conversation
View and its initial bottom position, making the row visible again.

The cause is in `MessageList`'s two follow-intent flags. A user send calls
`forceScrollToCurrent(SEND_CATCH_UP_DELAYS_MS)` and sets
`shouldAutoScrollRef`, but leaves `thinkingDeltaFollowAllowedRef` false. The
first later visible thinking delta therefore calls `stopFollowingForUserScroll`
even though no user scroll occurred; that also clears the send catch-up timers.
The explicit Follow action already avoids this by calling
`forceScrollToCurrent(..., { allowThinkingDeltas: true })`.

The fix should give the user-send `scrollTrigger` path the same permission to
follow subsequent thinking deltas, while retaining wheel, touch, keyboard, and
scrollbar gestures as authoritative cancellation. Keep the reproduction above
as the regression test. This is related to Conversation View height changes as
suspected, but the demonstrated transition is post-send thinking growth, not
the 30-second activity-height reserve releasing after a shrink.

The gap remains open because this follow-up diagnosed the unrelated defect but
did not authorize a behavior change. Its governing visibility contract is in
`topics/message-control-steer-queue-btw-later-interrupt.md` under **Deferred
queue reconciliation**.

Found 2026-08-10 while adding file-viewer version-control actions.
