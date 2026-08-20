# Dirty-file session actions cannot always show the session title

`packages/client/src/pages/WorkingTreeBrowser.tsx` labels a dirty file's
last-editor action from the current client summary snapshot. When that snapshot
contains the attributed session, the right-click menu and selected-file header
show its display title. A cold, old, archived, or otherwise absent summary falls
back to the session id prefix, so the requested title is not guaranteed.

The current path deliberately starts no attribution or session query when a
file is selected. Fixing the gap therefore needs either a bounded canonical
session-summary lookup shared by every attributed row, or an optional title
snapshot added to the dirty-editor response under a new capability. The former
must avoid one request per file; the latter must define title-change freshness
and must not turn the dirty-editor store into a duplicate session catalog.

Found 2026-08-20 while verifying titled dirty-file session navigation.
