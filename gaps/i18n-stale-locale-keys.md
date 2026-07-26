# Non-en locale catalogs carry stale keys absent from en.json

The locale catalogs are deliberately partial (en.json has ~2124 keys, the
translations ~1283, missing keys fall back to English at `i18n.tsx:104`), so
key-set parity is not the convention. But each non-en catalog also carries 4
keys that no longer exist in en.json at all — `bulkArchiveAll`,
`bulkArchiveAllFilteredTitle`, `localAccessRelayDebugDescription`,
`localAccessRelayDebugTitle` — dead entries left behind when the en keys were
renamed or removed.

Cheap fix: delete the stale keys from de/es/fr/ja/zh-CN, and add a small test
asserting every non-en catalog key exists in en.json (the reverse direction —
full parity — would contradict the partial-translation convention and must not
be asserted).

Found 2026-07-26 while adding the missing `actionMinimizeSidebar` /
`actionRestoreSidebar` translations.
