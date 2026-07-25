# Pre-existing failing test: Speech backend "validating" accessible name

`packages/client/src/pages/settings/__tests__/SpeechSettings.test.tsx`
("shows a validating backend immediately…") fails:
`getByRole("button", { name: /NeMo Parakeet STT speechSettingsBackendValidating/ })`
finds nothing because the button's accessible name computes with no space
between the label span and the status span —
`NeMo Parakeet STTspeechSettingsBackendValidating`.

Pre-existing: reproduced identically on a clean detached-HEAD worktree at
`5112aa39` with unmodified sources (checked 2026-07-25 during the
settings-search row conversion, which surfaced it; that change did not
touch the backend option markup).

Likely fix: either insert whitespace between the spans in the backend
option button, or loosen the test regex (`STT\s*speechSettings…`) —
accessible-name computation joins text nodes without inventing spaces, so
the markup is the more honest fix site.

Out of scope for the settings-search work that surfaced it.
