# Settings search cannot always confirm or broadly navigate a result

Settings search intentionally renders live setting controls, but an explicit-
confirmation control can still place its Save action outside the matched
result block and may not accept Enter. A user can edit the value in search
without an available way to commit it. Result navigation is also limited to
the small `Category › Section ›` link even though the inactive background
of the result row could provide a larger jump target.

The required interaction and its control-safety constraints are specified in
[`topics/settings-search.md` § Known limitations / candidate refinements](../topics/settings-search.md#known-limitations--candidate-refinements).
Implement it at the shared search/result row boundary, then verify at least one
explicit-save setting and one ordinary immediately-applied setting. Background
navigation must not consume control clicks or text selection.

Found 2026-08-11 while making category selection clear Settings search.
