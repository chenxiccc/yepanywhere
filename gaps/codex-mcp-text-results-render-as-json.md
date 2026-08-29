# MCP text tool results render as a JSON envelope instead of their text

Codex 0.151 always converts an MCP tool result into content items
(`convert_mcp_content_to_items` in `codex-rs/protocol/src/models.rs` no longer
returns `None` for text-only results), so a plain-text MCP result now arrives as
`[{"type":"input_text","text":"…"}]`.

`normalizeCodexToolOutput` handles a non-string output by pretty-printing it
(`packages/server/src/codex/normalization.ts:706`), so the user reads the text
wrapped in a JSON array and a `type`/`text` envelope rather than as the result.
This is not a 0.151 regression — the previous shape was a serialized JSON string
of the raw MCP content array, which rendered about as badly — but the new shape
is typed, so unwrapping is now cheap: when every item is `input_text`,
concatenate the `text` fields and keep the array as the structured value. Audio
and encrypted items should keep the current envelope.

`CodexFunctionCallOutputContentItemSchema`
(`packages/shared/src/codex-schema/session.ts:188`) already accepts all four
item kinds, so this is purely the presentation half.

Found 2026-08-29 while refreshing Codex compatibility to 0.151.0
(`topics/provider-refresh.md`).
