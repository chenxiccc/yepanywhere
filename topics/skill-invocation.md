# Skill Invocation

> Skill invocation is the composer affordance that resolves `/name` and
> `$name` tokens against skills available to the active provider while
> preserving all other text as free-form, sendable instructions.

Topic: skill-invocation

Status: **implemented** (2026-07-30). This contract covers skill discovery,
composer feedback, and submission semantics. It does not choose a skill
argument schema or an interview format.

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

This falls under [[vanilla-defaults]]' explicitly invoked
slash-command-transform carve-out: nothing changes until the user deliberately
types or selects an invocation token. The richer rows extend YA's existing
provider command menu rather than adding a new default-visible feature surface.

## Contract

### Resolve tokens against the live inventory

- The active provider/session's reported skill inventory is the authority for
  whether a name is an available skill. YA should not infer installation from a
  built-in list or from text resemblance.
- Inspect invocation-shaped tokens throughout the composer, not only at the
  beginning of a turn. An exact `/name` or `$name` match may resolve to the same
  skill identity even when one spelling is the provider's canonical invocation
  form.
- A provider-native slash command wins an exact leading `/name` collision,
  consistent with [[emulated-slash-commands]]. Away from the leading
  command position, `/name` may still resolve as a skill alias. If the provider
  identifies a native command as skill-backed, YA may present that provenance
  without creating a duplicate launcher entry.
- A name that does not resolve remains ordinary, sendable composer text. YA may
  mark it as unrecognized only while the inventory is current, but must not
  claim that the skill will run.
- Recognition and provider dispatch are separate. The resolver should retain
  the user-authored spelling plus the resolved skill identity and canonical
  provider spelling. Any provider-bound rewrite belongs to an explicit adapter
  or emulation contract, not to a generic text parser.

The inventory has three epistemic states:

- **current** — provider-supplied metadata may confirm or reject an exact name;
- **unavailable** — YA has no provider inventory for this session state;
- **stale** — YA retains displayable prior metadata but cannot use absence as
  evidence that a skill is missing.

Unavailable or stale inventory must not produce a “not installed” diagnostic.
The user may still send the text and let the provider resolve it.

The launcher builds on the existing command inventory rather than creating a
parallel prompt-library store. `SlashCommand` carries description, argument
hint, provider details, and optional emulation; its optional invocation metadata
distinguishes native commands, skills, and YA emulation, records the provider's
canonical sigil, and preserves aliases where the provider reports them. Older
servers without this enrichment remain a legacy command-name inventory and must
not be reinterpreted as confirmed skills.

### Keep the invocation editable

Typed completion is available only for a root invocation draft: the text before
the `/` or `$` is empty or whitespace, and the caret is at the end of the
composer. Enter or Tab may accept a visible completion in that state. Completion
stays entirely inactive while editing inside a draft, after intervening text,
or when text follows the caret, so those keys retain their normal composer
behavior. Invocation recognition and provider translation still inspect exact
tokens throughout the submitted text.

Selecting a typed completion replaces that root invocation token. Selecting a
skill from the launcher appends it when no completion token is active. Both use
the provider's canonical spelling, add a trailing space, and leave focus in the
composer. Selection does not submit, open a required form, or replace the
composer with a parameter editor.

The launcher may show:

- display name and one-line description;
- provider/source and availability;
- the provider's canonical sigil;
- an argument or usage hint, explicitly presented as a hint.

Typed `/` and `$` invocations receive the same resolution feedback as a
launcher selection. Positive recognition should be visible without adding
friction to every send—for example, a quiet status treatment near the composer.
The typed spelling may remain visible while editing. After submission, YA may
show the canonical provider spelling.

### Treat non-invocation text as opaque prompt text

The resolver returns source spans into the authored text. YA must preserve
everything outside recognized invocation spans verbatim and replace only a
recognized noncanonical invocation token when an explicit provider adapter
requires it.

- A bare invocation is valid. The skill may proceed immediately or ask for
  what it needs.
- Natural-language text before and after an invocation is valid.
- Several installed skills may be referenced in one message.
- YA must not tokenize, reorder, quote, or synthesize argument values merely
  because a skill advertises an `argumentHint`.

For example, all of these remain sendable:

| Composer text | Resolution |
|---|---|
| `$doubt` | Installed `doubt` skill, with any missing detail left to conversation. |
| `/doubt independently verify the numerical claims` | The same skill plus an opaque modifying instruction. |
| `$wish for about 20 minutes; prioritize the docs` | A skill invocation whose tail may mix argument-like and prose content. |
| `compare this with /doubt and then $review` | Two installed skills embedded in ordinary prompt text. |
| `/not-installed keep this literal` | Plain prompt text, optionally marked as an unrecognized invocation. |

### Warn softly; do not hard-fail

In v1, provider descriptions and `argumentHint` values are display metadata,
not evidence that prompt text is malformed. YA may show the advertised usage
beside a completion or recognized skill, but must not synthesize a tail-shape
warning from it.

An unrecognized `/name` or `$name` may receive a soft diagnostic only when the
provider inventory is current. Such diagnostics are advisory:

- they do not disable Send or intercept Enter;
- they do not open a modal;
- they do not silently repair the text;
- they are not inferred from a prose description alone;
- they disappear or update when the text or live skill inventory changes.

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
- Inferring an invocation from a name that is not an exact token match.

## Provider dispatch

- Launcher and completion selection use the canonical spelling reported by the
  provider adapter.
- Codex skills are discovered through `skills/list`. A recognized `/name`
  spelling is translated to `$name` at provider ingress, while unknown slash
  text remains literal. Codex should also send the corresponding structured
  `skill` input item so the app-server can inject the skill without another
  model-side lookup.
- Providers with canonical `/name` skills may analogously translate a
  recognized `$name` alias at ingress.
- Providers that cannot distinguish skill provenance leave the entry as
  “command, possibly skill-backed”; YA must not invent stronger provenance.
- Provider skill-definition paths stay server-side unless a provider already
  defines them as safe public provenance. The client sends authored text, not a
  host filesystem path.

## Contract checks

- Exact installed-skill names resolve from both `/name` and `$name`, in any
  whitespace-delimited invocation position, without duplicate launcher entries.
- Typed completion appears only for a root invocation at the end of the draft;
  mid-draft and post-text invocations never intercept Enter or Tab.
- A native slash command wins an exact leading slash-name collision.
- Text outside recognized invocation spans round-trips byte-for-byte through
  recognition and provider translation.
- Bare invocations and surrounding text that do not resemble the hint remain
  sendable.
- Unknown skill-shaped text remains sendable and is never presented as a
  confirmed skill.
- Unavailable or stale inventory never produces a negative installation claim.
- A soft diagnostic cannot block submission.
- Inventory replacement updates completions and diagnostics without a remount.
- Questions requested after invocation use the conversation's normal input
  lifecycle rather than a launcher-specific interview state.

## Related topics

- [[emulated-slash-commands]] — provider precedence and explicit ingress
  rewriting.
- [[rich-interviews]] — separately banked structured, multi-round interview
  proposal.
- [[vanilla-defaults]] — provider-bound text remains verbatim except for
  explicitly invoked transforms.
