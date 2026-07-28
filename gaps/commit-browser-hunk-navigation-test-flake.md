# Commit-browser hunk-navigation test can race its key listener

`packages/client/src/pages/CommitBrowser.test.tsx` intermittently fails the
`uses n/p for symmetric hunk navigation except while typing` case after its two
`.line-hunk` nodes have appeared: the immediate `window` `n` keydown sometimes
does not call `scrollIntoView`. The same test passed immediately when rerun in
isolation, and the complete client suite subsequently passed.

The DOM-ready assertion may not prove that the window key listener's effect has
committed. A focused fix should give the test an observable listener-ready
boundary, or otherwise await the owning effect, rather than adding a delay.
This is outside the Source Control layout-polish behavior being changed.

Found 2026-07-28 while verifying Source Control layout and file-row polish.
