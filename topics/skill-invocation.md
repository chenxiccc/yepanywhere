# Skill Invocation

> Skill invocation is the composer affordance that resolves leading `/name` and
> `$name` text against skills available to the active provider while preserving
> the rest of the message as free-form, sendable instructions.

Topic: skill-invocation

Status: **proposed, not implemented** (2026-07-30). This proposal covers skill
discovery, composer feedback, and submission semantics. It does not choose a
skill argument schema or an interview format.

## Motivation

Skills occupy an awkward middle ground between commands and prompts. A harness
may advertise a name, description, and argument hint, but text after the
invocation often remains ordinary natural-language instruction: it can supply
an expected value, qualify how the skill should run, or do both. A missing
argument may intentionally cause the skill to ask questions in later
conversation turns.

YA should therefore help the user locate and invoke an installed skill without
pretending that a display hint is a grammar. Recognition is useful metadata;
it is not permission to reject prompt text.

## Proposed contract

### Resolve against the live inventory

- The active provider/session's reported skill inventory is the authority for
  whether a name is an available skill. YA should not infer installation from a
  built-in list or from text resemblance.
- At minimum, inspect the leading composer token. An exact `/name` or `$name`
  match may resolve to the same skill identity even when one spelling is the
  provider's canonical invocation form.
- A provider-native slash command wins an exact `/name` collision, consistent
  with [[emulated-slash-commands]]. If the provider identifies that command as
  skill-backed, YA may still present its skill provenance without creating a
  duplicate menu entry.
- A name that does not resolve remains ordinary, sendable composer text. YA may
  mark it as unrecognized, but must not claim that the skill will run.
- Recognition and provider dispatch are separate. The resolver should retain
  the user-authored spelling plus the resolved skill identity and canonical
  provider spelling. Any provider-bound rewrite belongs to an explicit adapter
  or emulation contract, not to a generic text parser.

The launcher should build on the existing command inventory rather than create
a parallel prompt-library store. `SlashCommand` already carries a description,
an `argumentHint`, provider details, and optional emulation. The current client
reduces that inventory to names in `useSession` and gives `MessageInput` a
string list; retaining the structured entries is the natural first seam for a
future implementation.

### Keep the invocation editable

Selecting a skill inserts its invocation token and a trailing space into the
composer, then leaves focus in the composer. It does not submit, open a required
form, or replace the composer with a parameter editor.

The launcher may show:

- display name and one-line description;
- provider/source and availability;
- the provider's canonical sigil;
- an argument or usage hint, explicitly presented as a hint.

Typed `/` and `$` invocations should receive the same resolution feedback as a
launcher selection. Positive recognition should be visible without adding
friction to every send—for example, a small resolved-skill treatment on the
invocation token.

### Treat trailing text as an opaque prompt tail

After a resolved invocation token, the complete remaining text is a prompt
tail. YA must preserve it verbatim apart from an already-declared provider
invocation transform.

- No tail is valid. The skill may proceed immediately or ask for what it needs.
- A tail matching the advertised hint is valid.
- A natural-language modifying clause is equally valid, whether or not it
  resembles positional arguments.
- YA must not tokenize, reorder, quote, or synthesize values from the tail
  merely because the skill advertises an `argumentHint`.

For example, all of these remain sendable:

| Composer text | Resolution |
|---|---|
| `$doubt` | Installed `doubt` skill, with any missing detail left to conversation. |
| `/doubt independently verify the numerical claims` | The same skill plus an opaque modifying instruction. |
| `$wish for about 20 minutes; prioritize the docs` | A skill invocation whose tail may mix argument-like and prose content. |
| `/not-installed keep this literal` | Plain prompt text, optionally marked as an unrecognized invocation. |

### Warn softly; do not hard-fail

When YA has enough provider-supplied metadata to suspect a mistake, it may
offer a grammar-checker-like squiggle under the relevant text. Hovering or
focusing it should explain the uncertainty and show the advertised usage, for
example: “This skill advertises `[duration] [guidance…]`; your text will still
be sent as written.”

Such diagnostics are advisory:

- they do not disable Send or intercept Enter;
- they do not open a modal;
- they do not silently repair the text;
- they are not inferred from a prose description alone;
- they disappear or update when the text or live skill inventory changes.

An unrecognized `/name` or `$name` is a candidate for the same soft treatment.
The warning should distinguish “YA cannot locate this skill” from “this text is
invalid”; the latter is not a conclusion YA can draw.

Hard validation remains appropriate for YA-owned operations with an actual
local grammar, such as a command that cannot act without a shell command. That
is a different contract from invoking a provider skill.

## Missing information and interviews

Omitted arguments should not trigger a YA-authored preflight questionnaire.
Invoke the skill and let its instructions and the provider's normal agent loop
decide whether follow-up is needed. Provider-native question requests can then
use YA's existing inline question lifecycle, possibly over several
conversation turns.

This keeps launch-time discovery independent from [[rich-interviews]]. A future
skill format with a real input schema could opt into a preflight form, but it
should still retain an “Additional instructions” path and should not change the
free-form default for ordinary skills.

## Non-goals

- Defining a portable skill argument schema.
- Deriving required fields from `argumentHint` or a natural-language
  description.
- Building or reviving the banked rich-interview protocol.
- Installing, vendoring, or synchronizing skills.
- Replacing hard validation for YA-owned commands whose operation has a real
  local precondition.
- Recognizing arbitrary inline `/name` or `$name` occurrences beyond the
  leading invocation position in the first version.

## Questions for implementation

- Should selecting a `/` alias replace it visibly with the provider's canonical
  `$` spelling, or preserve the typed spelling and translate only at provider
  ingress?
- What positive resolved-skill treatment is quiet enough for routine use while
  still making launcher discovery legible?
- How should discovery behave for stopped or resumed sessions whose provider
  skill inventory may be unavailable or stale?
- Can all providers report skill provenance separately from native commands, or
  must some inventories remain “command, possibly skill-backed”?

## Contract checks

- Exact installed-skill names resolve from both `/name` and `$name` without
  duplicate launcher entries.
- A native slash command wins an exact slash-name collision.
- Arbitrary prompt tails round-trip byte-for-byte through recognition.
- Empty tails and tails that do not resemble the hint remain sendable.
- Unknown skill-shaped text remains sendable and is never presented as a
  confirmed skill.
- A soft diagnostic cannot block submission.
- Questions requested after invocation use the conversation's normal input
  lifecycle rather than a launcher-specific interview state.

## Related topics

- [[emulated-slash-commands]] — provider precedence and explicit ingress
  rewriting.
- [[rich-interviews]] — separately banked structured, multi-round interview
  proposal.
- [[vanilla-defaults]] — provider-bound text remains verbatim except for
  explicitly invoked transforms.
