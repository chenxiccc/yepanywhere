# Dirty-file session actions cannot always show the session title

`packages/client/src/pages/WorkingTreeBrowser.tsx` labels a dirty file's
last-editor action from the current client summary snapshot. When that snapshot
contains the attributed session, the right-click menu and selected-file header
show its display title. A cold, old, archived, or otherwise absent summary falls
back to the session id prefix, so the requested title is not guaranteed.

The current path deliberately starts no attribution or session query when a
file is selected. Prefer a bounded canonical session-summary lookup over adding
a title snapshot to the dirty-editor response. When the user opens a file's
context menu, asynchronously fetch that attributed session's current title if
its row is absent from the source-keyed client session catalog, then merge the
result into that catalog. The open menu can update in place, and every later
row, header, or menu reuses the catalog row, so the fetch is needed only once;
concurrent openings should join the same in-flight lookup. Normal catalog
revalidation and metadata events own later title changes. A failed lookup keeps
the short-id fallback and may retry on a later explicit menu opening. File
selection remains query-free, and the dirty-editor store remains only an
attribution store rather than a duplicate session catalog.

Found 2026-08-20 while verifying titled dirty-file session navigation.
