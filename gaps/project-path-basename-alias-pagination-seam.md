# Unloaded path links cannot seed basename aliases below the page seam

The browser derives recent basename targets only from the loaded transcript
window in `applyRecentProjectPathLinks()`. A confirmed full-path link just above
the unloaded older-page seam can therefore be absent from replay while a bare
basename just below **Load older** is visible. That basename remains plain or
uses another target already present in the loaded prefix until the older page
is loaded.

The edge is innocuous and lowest priority. Closing it would require a bounded
server/compiler prefix fact or retained alias state that survives semantic
prefix trimming; it must not scan hidden history or let a later transcript link
retarget an earlier occurrence. Loading older should continue to recompile the
expanded window and may then supply the missing earlier target.

Found 2026-08-30 while adding prefix-causal basename aliases for project-file
links.
