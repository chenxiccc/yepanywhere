# PageUp and PageDown stop scrolling after scrollbar drag

After the transcript scrollbar is dragged, PageUp and PageDown can stop moving
the transcript until the content area is clicked. The same keys scroll normally
after that click. The observable failure is in the session transcript surface;
the relevant focus and scroll-intent handling is in
`packages/client/src/components/MessageList.tsx`.

This was not folded into user-turn keyboard navigation because the page keys
should retain native viewport scrolling rather than become turn shortcuts. The
repair should first reproduce which element owns focus after a scrollbar drag
across supported browsers, then either restore focus to the transcript
scrollport or explicitly route page-key scrolling there without stealing the
keys from editable controls.

Found 2026-08-10 while selecting keys for user-turn navigation.
