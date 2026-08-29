# Codex tool results with no paired call are dropped instead of shown

Codex can deliver a tool result that YA cannot pair with a visible tool call.
Both paths currently discard it:

- Durable transcripts: a persisted `function_call_output` with no `call_id`
  returns `null` from the reader
  (`packages/server/src/sessions/normalization.ts:990`).
- Live app-server: Codex 0.151 added a `functionCallOutput` thread item
  (`id`, `name`, `namespace`, `output` — no call id), which falls through
  `normalizeThreadItem`'s default and returns `null`
  (`packages/server/src/sdk/providers/codex.ts:5320`).

Both drops were deliberate: Codex classifies these standalone outputs as
external model context rather than a response paired with a visible tool call,
and projecting one as a `tool_result` would fabricate a tool exchange that never
happened, with no `tool_use_id` to attach it to.

The maintainer's call is that seeing them beats hiding them: the model acted on
that content, so a transcript that omits it misrepresents what the turn saw.
The fix is a rendering decision, not a correlation one — surface the output as
its own visible block that names the tool (`name`/`namespace`) and does not
claim to be the result of a preceding call, rather than inventing a paired
`tool_result`. Keep the "never fabricate a pairing" invariant while removing the
"therefore show nothing" consequence.

Found 2026-08-29 while refreshing Codex compatibility to 0.151.0
(`topics/provider-refresh.md`).
