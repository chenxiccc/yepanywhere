# Session Clone and turn-relative Fork

> Clone copies the latest completed session. Fork before/after copies a
> completed prefix at a selected real user turn. Both create a cold session
> without sending a message; Fork with summary remains a separate advanced
> workflow.

Topic: fork-from-turn

Status: repaired and unified 2026-08-01. The focused incident record and
implementation receipts are in
[`docs/tactical/075-session-fork-clone-unification.md`](../docs/tactical/075-session-fork-clone-unification.md).

See also:
[session-context-actions](session-context-actions.md) (fork-capability ground
truth, the per-turn "fork from here" decision this elaborates, and the handoff
decision revised by fork-after-summary),
[recaps](recaps.md) (the LLM-summary facility this generalizes, and its
shared-helper-vs-fork strategy split),
[side-session-config](side-session-config.md) (the shared helper side session
and its bounded lifecycle),
[provider-context-economics](provider-context-economics.md) (the cost of the
fork + generation step),
[session-hovercard-recent-activity](session-hovercard-recent-activity.md) (the
sibling mobile context-menu / dismiss discussion),
[provider-agnostic-btw-asides](provider-agnostic-btw-asides.md) (the other fork
consumer),
[synthetic-turn-injection](synthetic-turn-injection.md) (whether the single
summary user turn could instead be a sequence of synthetic user+agent turns,
per provider),
[settings-ui-placement](settings-ui-placement.md) (where the auto-open default
setting lives, and the default + live-override pattern it follows),
[transcript-display-objects](transcript-display-objects.md) (the durable
pseudo-turn used for fork-send progress and follow state),
[scrollback-view-stability](scrollback-view-stability.md) (the client transcript
window the trim dot controls).

## Observable contract

- The session-header overflow menu exposes **Clone** only when the connected
  server advertises `session-fork-turn-intents` and the selected provider
  advertises `supportsForkSession`.
- Clone copies through the latest completed response, titles the target
  `Clone: <source>`, records the source in `forkedFromSessionId`, navigates in
  the same tab, and opens cold with an empty target composer. It does not
  submit or move the source draft. Ordinary Clone/Fork targets do not set the
  `/btw` Mother link (`parentSessionId` plus `parentSessionKind`) and therefore
  never render `/btw` badges or parent-navigation controls.
- Every real user prompt has an inline **Fork from this turn** menu independent
  of the right-side turn rail. The first loaded real turn offers **After this
  turn**; later turns offer **Before this turn** and **After this turn**.
  **After with summary…** is an explicit secondary action.
- The prompt-action grid chooses its one-column, two-column, or one-row shape
  from rendered geometry and reserves that complete shape's block size. It
  remains pointer-addressable while hidden for hover. The following assistant
  turn must never cover or intercept a visible Fork control.
- Before/After create cold, message-less targets. Before retains the completed
  prefix preceding the selected human request; After retains that request and
  its complete assistant/tool response. Tool-result user rows, compact rows,
  injected context, and synthetic rows never count as human boundaries.
- Clone and After are disabled while the selected/latest response is active.
  YA does not wait implicitly and never substitutes a partial or before-turn
  boundary.
- The browser sends only a YA `sourceMessageId` plus the user intent. The server
  resolves provider-native message/turn/entry identity. Provider ids remain
  server-only and YA-visible session ids remain canonical.
- A failed explicit intent creates no target and leaves the source unchanged.
  The primary error describes that outcome; provider detail is diagnostic.
- The turn rail remains a desktop accelerator backed by the same handlers. Its
  normal two-anchor threshold is not a feature-availability gate.
- Older servers without `session-fork-turn-intents` expose none of this unified
  surface and receive no fork request. The server continues to parse legacy
  empty and `{ upToMessageId }` bodies for older clients.
- The lineage response fields are additive and self-gating. A new client
  recognizes an older server's `/btw` aside only from its generated `/btw`
  title, never from a bare `parentSessionId`; an old client receiving new
  ordinary Clone/Fork metadata sees no parent link and therefore cannot
  mislabel it as an aside.

## Historical first pass (superseded where noted)

- **Fork from a turn.** `SessionPage.forkBeforeUserMessage(messageId)` forks the
  session from just *before* a user message: it finds the prior user/assistant
  message as the anchor and calls `api.forkSession(projectId, sessionId,
  { upToMessageId: anchor })`, then navigates to the new session. Gated by
  `currentProviderInfo.supportsForkSession`. Surfaced per-turn through
  `MessageList` `onForkBeforeUserMessage` → `RenderItemComponent`
  `onForkBeforeUserPrompt` / `onForkBefore`.
- **Scrollbar turn notches.** `UserTurnNavigator` renders, per user turn, a jump
  marker (`handleAnchorClick`) **and** a trim dot (`onTrimAnchor(markerId)` —
  "load client transcript from this turn", i.e. drop earlier scrollback).
- **Compose drafts** are plain `localStorage[\`draft-message-${sessionId}\`]`
  (SessionPage builds that key; `useDraftPersistence(key)` reads it directly —
  no install-id indirection for the session composer).

## Historical fork-summary design

The remainder of this section records the design that produced the first
fork-summary implementation. Its assumptions that ordinary Fork consumes the
composer, seeds a retry draft, or requires the rail are superseded by the
observable contract above. The generated-summary job remains an explicit
**After with summary…** action.

Replace the current notch-menu **Fork from here** entry; no legacy label needs
to be preserved. The right-scroll turn marker context menu should stay narrow:

```text
Jump
Fork before…
Fork after…
Copy
Show from
```

The ellipsis means the action enters a fork composer mode or uses existing
composer text as instructions; it is not a wide modal opened from the notch.
**Show from** renames the currently implemented **Hide previous** (`onTrimAnchor`):
both load the client transcript from this turn, but "show from here" names the
result rather than what is hidden, and avoids overloading "before" already used
by **Fork before…**.

### Anchor meanings

- **Fork before…** anchors before the selected user request. This is the retry
  path: discard the selected request's original assistant response and continue
  differently from that point.
- **Fork after…** anchors at the completed turn boundary for the selected user
  request: keep the user request and all assistant/tool output responding to it,
  then replace later history. In transcript terms, the anchor is the last
  active-branch message before the next user turn. If there is no later user
  turn, the anchor is the completed current tail once the session is idle.

Both map onto the inclusive `forkSession({ upToMessageId })` primitive — the
slice keeps up to and including that UUID (`providers/types.ts`) — so **Fork
before…** sets `upToMessageId` to the last message *before* the selected user
turn, and **Fork after…** sets it to that last active-branch message *of* the
turn.

Canonical description, reused verbatim as the **Fork after…** menu tooltip and,
when the composer is empty, the fork-mode instruction badge: "Keep this request
and the agent's response to it, then replace everything after with an
LLM-generated summary that follows your instructions."

The default for summary replacement is **Fork after…**, not **Fork before…**.
That preserves the original agent boot/orientation work: instruction-file load,
initial repository reads, planning, and any derived state already present in the
assistant/tool output responding to the initial request. Forking immediately
after the first raw user message risks making the successor repeat that work or
start before the evidence that the original agent used.

If the selected response is still being written, **Fork after…** must not
silently degrade to the pre-response anchor. Either wait for the assistant turn
to complete and then fork, or show a visible pending state with Cancel.

Provider compact summaries are context, not human requests. A transcript-only
compact summary row (`isCompactSummary`) must not be accepted as the selected
source turn, and it must not start the "next user turn" for boundary finding.
If such a row is inside the retained window, however, it remains eligible as
the retained boundary/context excerpt so the generated summary can see the
provider's compact text.

### Composer fork mode

Selecting **Fork before…** or **Fork after…** activates a visible composer mode.
If the composer already contains text, YA treats that text as summary
instructions. If the composer is empty, the mode changes the placeholder so the
user can enter summary instructions.

For **Fork after…**, the composer mode is only shown when the composer was empty
when the action was invoked. If the composer already has text, there is no mode:
YA immediately treats the current composer contents as summary instructions and
starts fork-after-summary. In the empty-composer case, the temporary mode changes
the placeholder, shows a small badge/caption, changes the send icon to the fork
action, and adds Cancel:

```text
Fork after selected turn
Keeps this request and the agent response to it; replaces later turns with an
optional generated summary.

[Cancel] [Fork with summary]
```

- **Cancel** returns the composer to normal and preserves the user's text.
- **Fork with summary** sends the composer text as instructions for generating
  the summary, creates the target fork at the selected completed-turn anchor, and
  submits the generated summary as the next user turn in that fork. Empty
  composer text means "use the default summary template," not "no summary."

For **Fork before…**, the mode can share the same footer actions, but **No
summary** is the ordinary retry fork. A summary option is allowed but is less
central; its generated text would explain how to retry or modify the discarded
turn, not summarize a retained prefix.

### Keyboard shortcut

Add a composer shortcut for the fast path, tentatively `Ctrl+Alt+Enter`:

```text
Ctrl+Alt+Enter: fork after the initial turn with summary instructions
```

The shortcut uses the same composer fork mode and semantics as the context-menu
path, with the default anchor set to the completed first user turn — the first
user request plus the assistant/tool output that handled it. If the composer has
text, the shortcut sends it as summary instructions. If the composer is empty,
it activates the visible fork mode so the user can type instructions or choose
**No summary**.

The shortcut must be listed in the session keyboard-shortcuts popover. It must
not change normal Enter / Ctrl+Enter send behavior, and it must not send the
composer text to the current session.

### Summary generation flow

The summary is produced by the **generalized recap/summary facility** (the
refactored `generateRecap`; see [recaps](recaps.md)). Recaps already define two
execution strategies — a shared helper side session for the cheap recent-text
recap, and *forking the main session/original model for higher fidelity*
(`recaps.md`). Fork-after-summary is exactly that high-fidelity fork strategy,
extended with an after-turn pointer and free-text summary instructions applied to
the **whole** retained-to-discarded context, not just recent assistant text.

The current source session must not be polluted by a "summarize yourself" turn,
and a fork (not a resume) is what makes that possible: the SDK `query()` exposes
no `skipTranscript`, so a `resume:`-based one-turn summary would append a visible
turn to the *source* transcript (`recaps.md`). Generation therefore runs on a
throwaway fork — only that fork's jsonl receives the instruction turn:

1. Fork the full source session into a generator fork (byte-identical prefix;
   inherits source prompt-cache warmth while it lasts). The after-turn pointer,
   plus a human-readable boundary excerpt when available, tells the summary
   prompt which completed-turn prefix the target fork will retain. This is the
   high-fidelity strategy's fork, run through the shared helper side session
   ([side-session-config](side-session-config.md)).
2. Submit the YA template plus the composer instructions to the generator fork.
3. Capture the assistant's generated summary.
4. Create the *target* fork at the selected **Fork after…** anchor.
5. Submit the generated summary as the next user turn in the target fork and
   navigate there.

The generator fork is implementation scaffolding, not the user's target branch.
Its lifecycle is required by the no-`skipTranscript` limitation above, not
incidental: it must be cancellable, bounded by the helper-session lifecycle
rules, and either auto-archived or clearly marked so it does not clutter normal
session lists.

### Summary template contract

The generated prompt should make the retained prefix explicit so the summary
does not repeat work already present in the fork:

```text
Summarize the useful state after the retained fork boundary for a peer-agent
handoff. The target fork already includes the original request and the
assistant/tool work through the selected completed turn. Do not repeat setup,
instruction loading, initial repository orientation, or investigation already
present in that retained prefix.

The summary will be submitted as the next user turn in the target fork. Preserve
decisions, constraints, current state, changed files, verification evidence,
open risks, and the next useful action. Do not continue the task.

Additional user instructions:
<composer text, if any>
```

The submitted summary displays as a normal user turn and is part of the target
fork's provider context. Content after the retained user turn can be collapsed in
the source outline, but the summary itself should not get a special transcript
role. Nice-to-have, low priority: YA may insert a non-context UI element
immediately before the summary showing the user's typed summary-amendment
instructions; that element is viewer state only and is not submitted to the
provider.

### Enhanced summary: computed prelude/postlude around the model body (partly built)

Upgrade the submitted user turn from free prose to a **layered** structure. Only
the middle is model-generated; YA wraps it with a **fixed computed prelude and
postlude** it assembles deterministically (the model cannot reliably know the
target fork's session id, the anchor message id, or the source-active flag, so
those must be computed, not prompted). None of this needs provider changes — it
is all content in the one submitted turn, so it works on every provider that can
fork (why we are *not* splitting into multiple synthetic turns:
[synthetic-turn-injection](synthetic-turn-injection.md)).

Layout of the submitted turn:

```text
<title line>                 model — first line of the generated summary
<provenance header>          computed prelude (deterministic, at last moment)
<summary body>               model — the generated summary
<handoff close>              computed postlude — only if source-active: yes
```

This is two separable workstreams, and they commit independently: the **UX**
(fork-send progress/follow, below) is the priority and lands first; the
**summary-instruction template + computed prelude/postlude** here is a later,
distinct commit.

1. **Title line (model, implemented).** The summary's **first line** is a concise title
   (≤ ~120 chars, no trailing period) naming the task/state, used verbatim as
   the forked session's `title` (the `forkSession({ title })` option) and as the
   follow-hyperlink label (see fork-send section). The instruction template — the
   only model-facing template work, "if any" — asks the model to lead with this
   line; everything else here is computed, not prompted.

2. **Provenance header — computed prelude**, emitted immediately after the
   title. Compute it at the **last moment** — when summary generation completes
   and YA assembles the final turn — not at activation:
   - `forked-from: <source session id> @ <project cwd>`
   - `summary-ends-at: <anchor message id>` — the completed-turn boundary the
     target fork retains. Everything in the source *after* this id is the source
     branch's own divergence, not this branch's history.
   - `source-active: <yes|no>` — computed at summary completion. `yes` if the
     source was live or, crucially, if the user **entered a turn in the source
     during generation**. Sampling at the last moment (after the 30+ s wait, not
     at activation) is what catches that continued user interaction: a turn typed
     into the source while the summary was generating is strong evidence the
     source is the user's primary line, which the postlude honors by waiting for
     an explicit go.

3. **Handoff close — conditional computed postlude.** Emit the postlude **only
   when `source-active: yes`** (the user acted in the source during generation).
   In that case it instructs the receiver: do **not** take over autonomously —
   state that you are holding and **wait for an explicit "go" from the user**
   before resuming, because the live source is the user's primary line and two
   branches must not do the same work.

   When `source-active: no` (no user action during the summarize phase), there
   is **no postlude at all**. The summary body plus the fork itself imply
   continuation, so the receiver just takes over; no "intent to take over"
   boilerplate is added.

The source pointer is the dereference escape hatch for that decision: trust it
for *current* liveness (is the source still going?), not for this branch's
authorizations (the source may have diverged past the anchor). The postlude,
when present, supersedes the bare "Do not continue the task" line in the template
above, which was aimed at the *generator* fork; the close governs the *target*
fork's receiver.

### Capability and default posture

Show these actions only where YA has a real prefix-fork primitive. Claude is the
validated provider today. Do not emulate a button named fork with a template
handoff on providers that cannot actually fork; that would hide a different cost
and context shape behind the same label.

Cost: fork-after-summary pays for one generation turn over the forked context
plus the two forks; the generation reprocesses uncached input when the source
prompt cache has gone cold. Per [provider-context-economics](provider-context-economics.md),
surface that price rather than hide it behind the button.

Fork cache-economics assumption: the value of using a real provider fork for
retitle, recap, and fork-after-summary helpers rests on the retained prefix
rendering as byte-identical model input, not merely on YA preserving the same
visible transcript. If the helper fork's first model turn is served by the same
provider backend node, cache shard, or retained-prefix tier that just processed
the source session, the large prefix prefill should be economically free or
near-free for the user (subscription quota or discounted cached-input billing),
with only the helper instruction and output paid at normal cost. That is an
assumption to verify, not a provider guarantee: routing to a different backend,
a provider-side cache miss, or any launch-time injected bytes before the cache
breakpoint can turn the helper into a full replay of a 900k-token prefix.
Default-enabling high-context helper forks therefore needs usage evidence from
the provider (`cache_read_input_tokens`, `cached_input_tokens`, billed-input
details, or equivalent subscription accounting), or UI copy that names the
uncached full-prefix cost.

Cache-affinity contract and implementation plan:

- **Retained prefix stays first and byte-identical.** Provider adapters must not
  put helper-only metadata, YA provenance, timestamps, working-tree refreshes,
  title-generation instructions, recap instructions, or fork-summary instructions
  before the retained provider prefix. Helper instructions are appended as the
  first new turn after the fork boundary, so everything before that boundary can
  hash to the same cache entry the source session just wrote or read.
- **Main sessions carry cache-family metadata.** When a provider exposes a
  routing or retention knob, YA should choose it at main-session start and store
  the value as provider metadata for the session's fork family. The value belongs
  to the retained-prefix lineage, not to the visible YA session id: helper forks,
  target forks, and later fork descendants that share the prefix reuse it.
- **Helper forks copy prompt-affecting configuration.** Before the helper's first
  turn, copy the source model, effort/thinking setting, endpoint/region or
  service tier, provider account/organization, cache retention/TTL setting,
  routing/cache key, tool inventory, MCP/plugin state, permission mode, and any
  other provider field that contributes to rendered prompt bytes or cache
  routing. If YA intentionally changes one of those fields, treat the helper as
  not cache-compatible and do not use cache warmth as a default-enable argument.
- **OpenAI API-backed providers should use `prompt_cache_key`.** For a future
  API-backed Codex/OpenAI provider, derive one stable cache-family key per source
  session lineage, send it on the main session and every fork/helper request
  with that retained prefix, and keep the chosen granularity below OpenAI's
  documented overflow risk for one prefix/key pair. Also pass the same
  `prompt_cache_retention` policy when configured. The success metric is
  `usage.prompt_tokens_details.cached_tokens` on the helper turn. Source:
  <https://developers.openai.com/api/docs/guides/prompt-caching>.
- **Claude and current Codex CLI/app-server paths are capability-limited.** The
  Claude Code contract is favorable: current docs say a fork inherits the
  parent's system prompt, tools, and conversation history exactly, so its first
  request reads the parent's cache. YA should still preserve Claude launch env
  such as `ENABLE_PROMPT_CACHING_1H`, avoid helper-only pre-prefix injection, and
  verify with `cache_read_input_tokens` / `cache_creation_input_tokens`. Current
  Codex app-server protocol files expose cached-token accounting but no public
  cache-routing key or retention override, so YA can only use native
  `thread/fork`/fork-session behavior and measure `cached_input_tokens` until a
  protocol refresh exposes more. Source:
  <https://code.claude.com/docs/en/prompt-caching>.
- **Track expected input cost from byte identity plus freshness.** Add
  `settings.cache-miss-billing` (Cache Billing: "Prompt-cache accounting") as an
  advanced default-off setting. Before usage is reported, YA derives an
  expected-input-cost state for forked and regular turns: the retained prefix is
  expected to cost **0 uncached prefix tokens** only when YA can say
  `prefixByteIdentical && freshEnough`. For forks, byte identity comes from the
  provider's fork contract preserving the retained prefix exactly. For regular
  same-session turns, byte identity comes from appending the next user turn after
  the same provider-owned session prefix. Freshness uses a provider-specific
  window: Claude defaults to 60 minutes because YA-owned Claude launches set
  `ENABLE_PROMPT_CACHING_1H=1`; current Codex app-server defaults to a
  conservative 10-minute measured window until a protocol refresh exposes a
  stronger cache-retention/routing contract.
- **Record misses, successful hits, and expected expiry as billing evidence.**
  When enabled,
  YA records provider usage observations for Claude and Codex turns where the
  expected-input-cost state is expected-free: the first assistant usage from a YA
  fork (including retitle, recap, and fork-after-summary helper/target forks),
  or a session turn within the provider freshness window after a provider turn
  or prompt-cache keepalive refresh. Claude observations must report
  `input_tokens`, `cache_read_input_tokens`, and `cache_creation_input_tokens`;
  Codex observations must report `input_tokens` and `cached_input_tokens` when
  the app-server protocol exposes them. If cached-read tokens are present and
  uncached input stays below the configured threshold, YA records an
  expected-cache-hit success. If cached-read tokens are zero and uncached input
  crosses the threshold, YA records an unexpected-recompute failure. Each record
  stores provider, session id, parent session id when present, message id / live
  message ordinal, usage fields, expected-input-cost state, and relative YA
  session link. This answers the economically important question: did a
  byte-identical retained prefix actually land on a backend/cache tier that
  reused the prefix, or did the provider assess full input cost?
  Beyond the configured provider freshness window, the same measurable miss is
  retained as expected-cache-expiry and a clean hit remains denominator
  evidence. Both are unexceptional, never alert, and are hidden behind the
  evidence-wide Include expected expiry filter.
- **Surface unexpected recomputes where the user can act.** The same setting
  controls an optional popup. When enabled, every unexpected cache-billing
  recompute emits an in-app warning with an Open Session action. The
  server-stored log keeps both failures and successes, side by side on wide
  screens and failures-first on narrow screens, so Claude and Codex evidence can
  be reviewed after the fact. Default-off is required because YA-novel billing
  warnings are instrumentation, not first-party-provider behavior.

This is an advanced explicit action. Normal composer send behavior remains
verbatim and unchanged; the feature is invoked only by the notch context menu or
the documented shortcut.

## Design decisions

- **Generate through the generalized recap/summary facility's fork strategy**
  (vs. a bespoke summary subsystem, and vs. a non-persisted query over a
  serialized transcript): one LLM-summary facility serves recap,
  fork-after-summary, and the planned handoff option. Full-context fidelity plus
  prompt-cache warmth need a real fork — the SDK `query()` has no
  `skipTranscript`, so a resume would pollute the source, and a serialized
  one-shot query would drop native message structure and cache warmth.
- **Two execution strategies under one facade** (vs. always-fork): recap stays
  the cheap recent-text helper-side-session query; fork-after-summary uses the
  fork strategy. Always-fork would make every on-return recap pay a fork +
  process spawn. (The split already exists in [recaps](recaps.md).)
- **Reintroduce agent LLM summarization as an explicit opt-in** (vs. the dropped
  agent-summarization posture in [session-context-actions](session-context-actions.md)):
  that posture held when no working LLM-summary path existed and template +
  source-session-id sufficed. Now that fork-after-summary builds a working one,
  the same summary-instruction control is offered as an option on standard
  handoff too; default stays template + pointer, the LLM summary is opt-in.
  This revises that doc's handoff decision.
- **Rename `generateRecap` → `generateSummary`**: the facility now emits both
  ≤40-word recaps and longer fork-after-summary handoffs, so "recap" (a
  GLOSSARY term) understates it; recap becomes a preset of the summary
  facility.

## Implemented surfaces

1. **Context menu on the notches.** `UserTurnNavigator` markers take
   `onContextMenu` (desktop right-click) and a ~450ms long-press (touch) that
   open a portaled menu (`.user-turn-nav-context-menu`) anchored with its right
   edge at the pointer, opening leftward (notches sit at the right edge).
   Items: **Jump**, **Fork before…** (`onForkBeforeAnchor`), **Fork after…**
   (`onForkAfterAnchor`), **Copy** (`onCopyAnchor`), **Show from**
   (`onTrimAnchor`). Plain click still jumps; the trim dot still trims. Dismiss:
   transparent overlay click, Escape, or selecting an item. New props are
   optional, so items render only when wired.
2. **Inline turn menu.** `ForkTurnMenu` is available from every real user
   prompt on pointer and touch layouts. `SessionPage` sends
   `before-user-turn` or `after-user-turn` to the server and navigates to the
   cold target without reading, clearing, submitting, or seeding composer text.
3. **Fork-after-summary.** `generateRecap` is refactored to provider
   `generateSummary` with side-session recap and fork strategies. Claude's fork
   strategy creates a throwaway full-source generator fork, submits the summary
   prompt there, then `/fork-summary` creates the target fork at the completed
   turn anchor and submits the generated summary as an ordinary user turn. The
   client exposes `api.forkSessionWithSummary`.
4. **Explicit composer fork mode.** Only **After with summary…** enters the
   temporary fork-summary mode. Existing composer text is not implicitly
   consumed by opening that action. Cancel exits without discarding text; the
   no-summary path delegates to the same server-owned After intent.
5. **Copy** uses the full turn text, resolved in `SessionPage` (`copyUserMessage`
   → `onCopyUserMessage` → `onCopyAnchor`), not the truncated `marker.preview`.
   Silent (matches the existing copy-prompt action; no toast / i18n key added).
6. **Header Clone.** The header-only `SessionMenu` handler sends
   `clone-latest-complete`, shows pending/disabled state, and navigates in the
   same tab. Session-list menus do not receive the handler, so Clone has one
   deliberate discovery surface rather than appearing on every row.

## Follow-up UI spec: inline turn actions and fork-after no-summary

Status: partly superseded by the 2026-08-01 observable contract. Inline access
and no-summary cold forks landed through the unified turn menu; range selection
remains a separate unimplemented proposal.

### 1. Reserve a lane for inline turn actions

Inline turn action buttons must have a reserved right-side lane. Turn text and
the user-prompt bubble must never render underneath that lane, even if the
buttons are hidden until hover, focus, proximity, or coarse-pointer activation.
The fix belongs in the shared turn/action layout, not as per-button overlap
patches.

This lane is separate from the scrollbar-aligned turn notches. The notches remain
the PC-friendly dense navigation surface, but inline action buttons are the
mobile-friendly path for common actions.

### 2. Stack inline action buttons vertically

The inline turn actions are too wide as a horizontal group. Present them as a
vertical stack in the reserved lane, ordered by priority:

```text
Copy
Edit
Fork before…
Show starting here
```

**Show starting here** is the lowest-priority action and belongs last, so it is
the first candidate to drop only if the available action space still cannot fit
the full set. Short turns may fit the four buttons horizontally; long turns are
where a vertical column usually pays off because it preserves transcript width
without creating an over-wide action row. Do not treat "short turn" as the drop
trigger by itself. The label replaces the older **Show from** wording for this
inline action because it names the resulting view state.

**Fork before…** must be visible in this inline stack whenever the provider
supports real prefix fork. The right-notch context menu already provides the
same operation on desktop, but that is not enough for mobile discoverability.

### 3. Fork-after no-summary alternate send

The fork-after-summary composer mode needs a second submit path in addition to
the existing generated-summary submit:

- Primary submit: fork after the selected completed turn and generate/submit an
  LLM summary, as implemented today.
- Alternate submit: fork after the selected completed turn with **no generated
  summary**. Expose this as a bottom action beside the primary button, and wire
  `Ctrl+Enter` to it while fork-after mode is active.

No-summary semantics:

- If the composer contains text, create/follow the target fork and submit that
  text verbatim as the next ordinary user turn in the fork.
- If the composer is empty, create/follow the target fork without submitting a
  turn.

The alternate path must not run the generator fork, must not rewrite the typed
text, and must not alter normal `Enter` / `Ctrl+Enter` behavior outside
fork-after mode. If speech capture or transcription is pending, both fork
buttons preserve the exact visible click-time snapshot and wait for that speech
transaction's terminal settlement. Both typed actions retain recovery ownership
of the detached draft until settlement-time admission accepts the dispatch.
Successful settlement dispatches once. A lifecycle failure or current-admission
rejection restores the detached draft and creates no fork; a synchronously
thrown typed action restores the draft before propagating its error. A spoken
command-only generated-summary action may validly submit empty
instructions, but it must invoke the typed generated-summary action rather than
generic empty message submission.

Wiring: `SessionPage` → `MessageList` (`onForkBeforeUserMessage`,
`onForkAfterUserMessage`, `onCopyUserMessage`, `onTrimBeforeUserMessage`) →
`UserTurnNavigator` (`onForkBeforeAnchor`, `onForkAfterAnchor`, `onCopyAnchor`,
`onTrimAnchor`). Fork stays gated by `supportsForkSession` (`SessionPage` passes
`undefined` otherwise, so the menu omits Fork).

### 4. Range selection from right-scroll turn notches

Add a way to select a contiguous range of turns from the right scrollbar notch
rail. Gesture is intentionally unresolved: drag, secondary mouse button, and/or
modifier-key selection are all candidates. The important contract is the
selection object, not the first gesture: two turn-boundary anchors produce a
visible selected turn range that can feed downstream actions.

Range-aware fork actions extend, rather than replace, the single-turn fork
actions:

- **Fork before selected turn with range summary** — fork at the specified
  before-turn anchor, then submit a generated summary of the selected turn range
  instead of summarizing all following turns.
- **Fork after selected turn with range summary** — keep the specified turn
  through its completed response, then submit a generated summary of the selected
  turn range instead of summarizing all source history after that turn.

This separates the fork boundary from the summary source range. The fork
boundary is a single turn boundary; the summary source is the selected range of
turns. That lets the user preserve the useful prefix while handing the successor
only the later slice that matters, rather than forcing "everything after the
anchor" into the summary prompt.

UI convenience: add a toolbar accelerator for the common case **fork after the
first turn**. It should invoke the same fork-after-summary machinery as the
notch/menu path, defaulting the boundary to the first completed user turn and
using the current composer text as summary instructions when present. This is a
speed path to an existing action, not a separate fork implementation.

## Fork-send: backgrounded progress and follow

**Status: implemented with the durable pseudo-turn.** Shipped: server-owned
background generation, phase + elapsed state, cancellation, the auto-open
attempt with a title-labeled hyperlink fallback, and the per-fork auto-open
toggle seeded from a persistent default. The progress/follow object is persisted
server-side and placed in transcript order; there is no separate transient
composer float.

**Original symptom (the bug this fixed).** The generation step is a full LLM turn over
the *entire* forked context — 30+ s, worse with a cold prompt cache (per
[provider-context-economics](provider-context-economics.md)) — but it is wired
as a blocking composer submit. The only feedback is the **greyed-out send
button**: no phase, no elapsed time, no ETA, no cancel, and the parent composer
is locked the whole time. The user cannot tell working from hung, so 30 s of
dead UI reads as a freeze. This generalizes the existing "show a visible pending
state with Cancel" rule (§ Anchor meanings, written for the response-still-being-
written case) to the generation wait, which was the unhandled case.

**Fix: make fork-send a backgrounded async job with its own persistent
indicator,** freeing the composer immediately.

1. **On activation,** dismiss the composer fork-mode apparatus at once
   (placeholder / badge / Cancel) and return the composer to normal — the typed
   instructions were already consumed as the summary prompt. Replace it with a
   **persistent "Forking…" display object**: a non-context viewer-only element
   (it must not become a real provider turn in the parent transcript; same class
   as the typed-instructions element noted above), placed after the source
   transcript tail as of activation. It shows phase ("Generating summary…") and
   elapsed time.

2. **On ready** (target fork created, summary submitted), **open the forked
   session in a new tab** when the live auto-open toggle is on. Current
   production behavior is default-off and non-persistent after the install-id
   localStorage excision; adding a browser-local or source-scoped persisted
   default would be a separate product behavior change (see
   [settings-ui-placement](settings-ui-placement.md)). Because generation
   typically takes 30+ s, the open is deferred to completion, not attempted up
   front.

3. **Auto-open fallback.** If the new tab cannot open (popup blocking, or a
   user "don't auto-open" preference), the indicator stays and surfaces a
   **hyperlink** the user clicks to follow at their choice. The hyperlink label
   is the **title line** (summary first line). Even when auto-open succeeds, the
   indicator may persist briefly as `Forked: <title> ↗` so the user has a way
   back.

   Lifecycle: `Forking… (Cancel)` → `Forked: <title>` (auto-opened, or a
   click-to-open link). One indicator per in-flight fork; concurrent forks are
   allowed if cheap, but a single-at-a-time MVP is acceptable.

**Two distinct cancels — do not conflate.**

- **Pre-send Cancel** (the existing composer fork-mode Cancel): the fork has not
  been sent, no summary has been generated. It simply drops the request and
  returns the composer to normal, preserving typed text. Cheap, no provider
  cost incurred.
- **In-flight Cancel** (on the progress indicator): the generator fork is
  already running an LLM turn. This aborts that in-flight generation (the
  generator fork is required to be cancellable per § Summary generation flow)
  and tears down the indicator. It must be clearly scoped to "stop this running
  fork," visually distinct from the pre-send drop, and should note that the
  generation turn already partially billed.

### Durable pseudo-turn

The follow indicator is a **durable pseudo-turn** placed in the session outline
at the source tail as of creation time. It is a
[transcript display object](transcript-display-objects.md) — a saved
display-only item with a placement, **not** a real turn (never in model
context). It **scrolls with content** (scrolls off with continued use, by
design), **updates in place** to `(tab opened)` when auto-open is detected, and
**marks `(clicked)`** when followed — but the object and its link **stay in any
case**. It is persisted in YA session metadata, so it survives device migration
and a YA restart.

The follow link's label is the **title line** (summary first line), shared by the
float, the pseudo-turn, and the forked session title.

**Implemented:** the durable object is created before helper work starts,
updated through generating/ready/error states, and retained after follow. A
server restart converts an interrupted generating object to an actionable error
instead of pretending the job is still live.

### Operation ownership and validation

Fork-after-summary is a server-owned job. The start endpoint validates the
selected user request and resolves its completed-turn boundary from the source
transcript before creating either fork, persists the display object, then
returns `202`. The requesting tab may disconnect without cancelling the job.

YA creates and archives the generator fork before invoking the summary helper.
It creates the target archived, starts the generated summary turn, and only
unarchives the target after the start succeeds. Cancellation aborts the helper
query; failures leave scaffolding archived and update the durable object rather
than orphaning visible sessions.

## Open questions / follow-ups

- Long-pressing a right-edge notch is a small touch target; may want a larger
  hit area or to surface the menu from the wider preview label on touch.
- Whether to share one context-menu component with the hovercard topic's mobile
  row-`…` menu proposal (shared dismiss rules).
- Copy has no visible confirmation (silent); add a toast if desired.
