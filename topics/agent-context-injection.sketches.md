# Agent Context Injection Sketches and Evidence

> Agent context injection is the provider-specific contract for placing YA,
> harness, and project instructions into model context, preserving designated
> sources across compaction, and refreshing mutable facts without destabilizing
> reusable prompt prefixes.

Companion to: [agent-context-injection](agent-context-injection.md)

Status: current-behavior contract plus proposed mechanisms. The provider
placement and compaction findings below describe current behavior. The optional
personal `~/agents` special-launch integration is an accepted direction for
internal coordination but is not implemented. The general prepared-boot manager
and protected boot capsule remain unapproved proposals; none is enabled by a
setting.

Related topics: [cache-aware session bootstrap](cache-aware-session-bootstrap.md),
[provider context economics](provider-context-economics.md),
[emulated slash commands](emulated-slash-commands.md),
[injected-message visibility](injected-message-visibility.md),
[synthetic-turn injection](synthetic-turn-injection.md),
[settings UI placement](settings-ui-placement.md), and
[federated super sessions](federated-super-sessions.md).

The personal instruction-corpus counterpart is
[`graehl/agents` agent-instructions](https://github.com/graehl/agents/blob/master/topics/agent-instructions.md#modeling-agent-capability-and-tendency).
It owns policy selection, model/harness tendency patches, and ablation; this
topic owns provider placement, launch mechanics, and compaction evidence. YA
does not depend on that repository for ordinary users.

## Scope and vocabulary

This topic uses *agent context injection* rather than *prompt injection*. The
latter commonly names an adversarial instruction attack; this topic is about
intentional context supplied by YA or a provider harness.

Provider context has several sources with different durability and authority:

- **Base or system instructions** come from the provider harness. A provider
  may reconstruct them exactly rather than include them in summarized message
  history.
- **Appended system or developer instructions** are host-controlled additions
  at a provider-supported instruction level.
- **Project-root instructions** are files such as Codex `AGENTS.md` or Claude
  Code `CLAUDE.md` that the harness discovers and injects.
- **Contextual world state** includes mutable facts such as cwd, date, shell,
  permissions, platform, tools, and collaboration mode.
- **Ordinary user messages** include the user's text and any YA wrapper
  prepended to that text. Calling the wrapper hidden in YA's UI does not give it
  a privileged provider role.
- **Tool-read material** includes scoped policy files such as `RESEARCH.md`,
  `RUNS.md`, and topic documents that an agent reads after an action-time rule
  fires.

For each source, implementations must distinguish five survival mechanisms:
exact reconstruction from current source, exact carry-forward, provider-managed
bounded reinjection, lossy conversation summarization, and reload after a
future trigger. “The agent probably remembers it” does not identify which
mechanism applies.

## Current YA placement

`buildEffectiveAgentContext` in `packages/shared/src/agent-context.ts` composes
enabled `[Client capabilities]` fragments before the free-form
`[Global instructions]` block. The server passes that result as
`globalInstructions`; provider adapters decide where it enters model context.

| Provider path | Placement | New provider process | Resumed provider process |
|---|---|---:|---:|
| Claude and Claude Ollama | `systemPrompt` preset `append` | yes | yes |
| Codex app-server | `[Global context]` prefix on first ordinary user message | yes | no |
| Codex OSS and legacy Gemini | same ordinary-user prefix | yes | no |
| Pi, OpenCode, Grok ACP, Gemini ACP | same ordinary-user prefix | yes | yes, on the first message after process launch |

Shared-hosted provider processes also receive YA-owned
`AGENT_LAUNCHER`, `AGENT_LAUNCH_HARNESS`, `AGENT_LAUNCH_MODEL`, and
`AGENT_LAUNCH_EFFORT` launch markers. The latter two record explicit
initial selections and do not change after live model or effort updates. These
markers let an installed global boot route known launch facts without
re-deriving them from a provider transcript; they do not implement the proposed
request-conditioned boot compiler or change instruction placement.

The non-Claude prefix has this provider-facing shape:

```text
[Global context]
<effective agent context>

---

<actual first user message>
```

YA's optimistic live echo shows the original user text and normally discards
the adapter echo as a duplicate. That is a presentation effect, not a durable
transcript-stripping contract. The placement discrepancy and the Settings-copy
decision remain tracked in
[`gaps/confusing-settings.md`](../gaps/confusing-settings.md).

The current LaTeX capability fragment prefers `\( ... \)` for inline math and
`\[ ... \]` for display math. The renderer continues to accept dollar
delimiters for compatibility, but `$` is more ambiguous in shell-like and
currency text. The exact fragment stays visible in Settings before opt-in.

## Provider compaction contracts

### Codex

**Established from pinned source (`rust-v0.147.0`).** Codex loads host-provided
global instructions and discovered project `AGENTS.md` files into one
`LoadedAgentsMd` chain, separated by a project-doc marker. Project discovery
walks from the repository root to cwd and is bounded by
`project_doc_max_bytes`; global instructions are supplied separately before
the project entries are appended.

The combined chain becomes one user-role `AgentsMdState` world-state section.
Both global and project entries therefore receive the same post-load compaction
treatment. On manual or pre-turn compaction, Codex clears its world-state
reference so the next turn injects the full cached state. Mid-turn compaction
inserts that state before the last real user message.

The cache is a creation-time or environment-selection snapshot, not a live
file watcher. Ordinary turns with the same environment selection do not reread
the selected global or project files, even when their contents change or they
are deleted. A cold root resume, root fork, or changed environment selection
loads current sources and emits a one-time replacement or removal notice when
they differ from persisted history. The pinned integration tests explicitly
cover same-path mutation, cold-resume removal, and fork replacement.

This is exact reconstruction of the selected combined AGENTS snapshot; it is
not a claim that AGENTS text has system/developer authority. Codex represents
it as a contextual user instruction. It also does not protect arbitrary files
that AGENTS later caused the agent to read.

Relevant pinned-source entry points:

- `references/codex/codex-rs/core/src/agents_md.rs`
- `references/codex/codex-rs/core/src/context/world_state/agents_md.rs`
- `references/codex/codex-rs/core/src/session/world_state.rs`
- `references/codex/codex-rs/core/src/compact.rs`
- `references/codex/codex-rs/core/tests/suite/agents_md.rs`
- `references/codex/codex-rs/core/src/session/tests.rs`

Codex also rebuilds contextual environment state for each step. In the pinned
source that state includes cwd, shell, current date, timezone, filesystem and
permission context, and subagent information. Changed facts arrive as state
diffs, so a long-lived or forked session need not trust the original date or
cwd. `include_environment_context = false` suppresses that bundle, but it is a
broad switch rather than a cache-only removal of date or cwd. No regular
model-context injection of Git HEAD/status was found in the pinned source;
Git metadata elsewhere in a rollout or telemetry record is not evidence that
the model received it.

Codex has no verified auto-compaction disable switch. Its default limit is
derived at no more than 90% of the model context window. Setting
`model_auto_compact_token_limit` to zero triggers compaction immediately; it
does not disable it. The `body_after_prefix` scope makes the soft threshold
count growth after a retained prefix, while the full context-window cap still
applies. YA can request compaction earlier with a safety margin, but one large
turn can still cross both thresholds.

### Claude Code

**Established from Anthropic documentation.** Claude Code does not natively
discover `AGENTS.md`; its analogous source is `CLAUDE.md`. A repository may
expose AGENTS content through a root `CLAUDE.md` import or symlink, but it then
participates in Claude's CLAUDE-loading contract rather than a native AGENTS
contract.

After compaction:

- the system prompt and output style are unchanged;
- project-root `CLAUDE.md`, unscoped rules, and auto memory are read from disk
  and re-injected;
- path-scoped rules and nested `CLAUDE.md` files are absent until another
  matching file read;
- invoked skill bodies are re-injected with per-skill and total token caps; and
- ordinary conversation and tool reads are summarized.

Anthropic's current documentation explicitly names project-root CLAUDE but
does not state the same guarantee for user-global CLAUDE. YA must not infer
global/project parity from the project guarantee alone.

YA's `globalInstructions` uses the Agent SDK's `claude_code` preset `append`,
so it stays in the unchanged system prompt on both new and resumed processes.
YA does not currently request the SDK's `excludeDynamicSections` option. That
option moves cwd, Git-repository presence, platform, shell, OS version, and
auto-memory paths from the system-prompt prefix to the first user message. It
improves cross-directory system-prompt reuse at the cost of slightly lower
instruction authority for those facts.

Claude separately supports `includeGitInstructions: false`, which removes both
its built-in commit/PR workflow text and the Git status snapshot. That is a
coupled behavior change, so a cache-oriented implementation must supply any
workflow contract it still needs. No official source found for this survey
establishes a current-date injection in Claude's model context; JSONL
timestamps alone do not establish one.

Claude supports `DISABLE_AUTO_COMPACT=1`, leaving manual `/compact` available,
and `DISABLE_COMPACT=1`, disabling both automatic and manual compaction. These
are viable controls for an experimental YA-owned compaction boundary, subject
to a hard context-limit recovery path.

### Other providers

YA's Pi, OpenCode, Grok, Gemini, and Codex OSS placement is established by the
current adapters. Their native compaction, fork, and instruction-file
durability have not been verified to the same standard. They remain
`unknown`, not assumed equivalent to Codex or Claude.

## Harness-owned explicit state

A provider command that can display current goal, plan, or mode state is a
useful lead: the harness may own a structured record outside compactable
conversation history. Display fidelity alone is insufficient. Protected model
state requires all three properties:

1. an authoritative store independent of summarized message history;
2. fresh model-context injection, or a mandatory model query, after compaction
   and resume; and
3. explicit update, replacement, completion, and clearing semantics so stale
   state does not remain a standing instruction.

### Slash commands are not one state mechanism

A `/name` surface does not identify where its behavior lives or what survives
compaction. Each command needs a **slash-command implementation class** and a
separate inventory of its lasting effects:

- **Fixed harness command:** the CLI performs local or provider-control logic
  without asking the main model to interpret a prompt. Persisted settings and
  transcript display are separate possible effects.
- **Prompt-backed skill or command:** rendered instructions enter model context
  as a message. The assistant response is an ordinary model response, while
  compaction survival follows the harness's skill/message rules.
- **Provider-control command:** the harness calls a structured provider API or
  updates an independent state store. Model reliability still requires the
  reinjection/query and replacement tests above.
- **Hybrid command:** local logic, synthetic turns, hooks, and one or more model
  calls cooperate. Each resulting state family needs to be classified rather
  than treating the command name as one atomic operation.

Claude Code explicitly mixes these classes. Its command reference says most
built-ins execute fixed CLI logic, while bundled and user skills hand a prompt
to Claude. Invoking a skill inserts its rendered body as one message; Claude
re-attaches recent invoked skills after compaction only within per-skill and
combined token caps. Dynamic skill shell substitutions run before the model
sees the rendered prompt.

The observed Claude JSONL for session
`b44a8ffd-b6d0-4fcf-988e-58e128efef21` makes `/goal` more concrete. It records,
in order:

1. a user-role `<command-name>/goal</command-name>` invocation;
2. a user-role `<local-command-stdout>Goal set: ...</local-command-stdout>`
   status turn;
3. a synthetic user-role directive telling the main assistant to acknowledge
   the goal and continue working; and
4. the visible assistant acknowledgement.

Anthropic documents `/goal` as a built-in shortcut that installs a
session-scoped prompt-based Stop hook. A Stop hook receives the main turn's
`last_assistant_message`; a prompt-based hook then sends its hook input and
evaluation prompt to a separate Claude call and consumes the resulting
structured decision. The evidence therefore establishes both injected turns
and harness inspection of model output. It does **not** show the visible main
assistant acknowledgement being captured or suppressed as a hidden command
result; that response remains an ordinary transcript turn.

This matters to YA compaction and fork work. A command invocation and local
status turn may be ordinary compactable history even when the hook or setting
they created lives elsewhere. A skill body has its own bounded reinjection
contract. A Stop-hook condition and evaluator result have still different
lifecycles. Slash-command discovery or faithful transcript rendering therefore
cannot stand in for a state-parity check across native compaction, resume, and
YA fork-summary transitions.

**Verified Codex goal example.** Pinned Codex persists thread goal objective,
status, budget, and usage independently of the transcript. App-server exposes
`thread/goal/get`, `thread/goal/set`, and `thread/goal/clear`; resume restores an
active goal; fork can carry it with deferred continuation; and automatic goal
turns render a hidden `InternalModelContextFragment` from the current persisted
goal. `/goal` therefore reads real harness state, and active continuation does
not depend on a compaction summary remembering the objective exactly.

The relevant source is under `references/codex/codex-rs/ext/goal/`, especially
`src/runtime.rs`, `src/steering.rs`, and the templates in
`references/codex/codex-rs/prompts/templates/goals/`. App-server goal and fork
fields live in
`references/codex/codex-rs/app-server-protocol/src/protocol/v2/thread.rs`.

**Codex plan counterexample.** `update_plan` is a TODO/checklist tool, not Plan
mode. Its handler emits a `PlanUpdate` event and returns `Plan updated`, but no
current-plan world-state section or post-compaction reinjection path was found
in the pinned source. YA can render the exact historical tool event without
establishing that the model still has the checklist verbatim. Plan state stays
unprotected until an independent store plus model-injection path is shown.

Provider-native goal state can reduce what a YA capsule must duplicate, but it
does not preserve activated policy bodies, acceptance details, or rationale
that the goal schema does not contain.

### Native compaction is not fork-summary compaction

A provider-native compact operation can run harness-owned post-compaction
reconstruction. YA's separate pattern of forking a transcript and sending a
YA-requested summary is a new session transition; it must not be described as
equivalent unless every relevant explicit-state family has a verified carry or
replacement path.

The current Codex path demonstrates the gap. Pinned app-server copies an active
thread goal into a fork only when `deferGoalContinuation: true`; that flag also
prevents the inherited goal from starting automatic work before the first
explicit target turn. YA's `createThreadForkParams` in
`packages/server/src/sdk/providers/codex.ts` does not set the flag. A current YA
fork can therefore preserve transcript history while dropping provider-owned
goal state, and a subsequent summary request does not reinject that goal.

Any YA-owned fork-summary compaction must inventory provider-owned goal, mode,
plan, memory, and other explicit state before the fork. For each family it must
either invoke a provider-supported carry/reassertion path, deliberately clear
it with user-visible semantics, or report that the approximation is not
state-equivalent to native compaction.

## Routing rules are not routed policy bodies

This repository deliberately keeps the always-loaded AGENTS layer focused on
action-time triggers: read `RESEARCH.md` before substantive research, read
`RUNS.md` before operating long jobs, and read a relevant topic when entering
its concern. This saves context because the much larger governed corpus is
loaded only when needed.

Compaction creates an important split:

1. Codex can reconstruct the AGENTS trigger exactly.
2. The earlier tool read of `RESEARCH.md`, `RUNS.md`, or a topic is ordinary
   history and may survive only through a lossy summary.
3. The trigger may not fire again merely because compaction occurred. An agent
   already performing the governed action can continue without crossing the
   trigger boundary a second time.

This makes selective survival useful and risky. Pinning the entire global
policy corpus would consume a large protected prefix and force more frequent
compaction. Pinning only routing rules saves tokens, but compliance can degrade
across repeated summaries unless active governed material is reconstructed or
reread deliberately.

**Observed Codex trace.** The long-running Codex session
`019fe326-4499-79a1-8b8d-5935140e7efd` contained 103 compaction records in the
snapshot examined on 2026-08-11. Every replacement history contained the full
AGENTS startup item. Replacement histories exposed an ordinary message plus an
opaque encrypted compaction item, not a human-auditable summary of prior tool
reads. Only 24 of the 103 compaction boundaries were followed within 180
seconds by any tool invocation whose command mentioned `RESEARCH.md` or
`RUNS.md`. That count includes mentions and searches as well as reads, so it is
an upper bound on immediate rereads. The trace supports exact AGENTS
reassertion and occasional emergent policy rereading; it does not establish
that routed policy bodies survive compaction faithfully.

A future context manager should track an **active governed-supplement
manifest** rather than pin every possible policy file. Each activated source
needs at least:

- canonical path and content hash;
- activation trigger and governed action/scope;
- activation time or turn;
- required authority and exact-versus-summary requirement; and
- freshness rule for deciding when the source must be read again.

At compaction or fork, YA can reconstruct exact load-bearing excerpts in a
protected channel or require a fresh read before the next governed action.
The manifest must never claim a file was reread merely because its prior hash
is known.

## Cache-compatible dynamic context

Prompt caches reuse exact prefixes. Static provider instructions, tools, and
project boot material should precede request-specific text, but correctness
still outranks cache identity.

Dynamic inputs fall into three classes:

- **Omittable and tool-queryable:** date and Git status can be omitted when the
  harness supports that choice and the agent can call `date` or Git when the
  fact matters.
- **Movable:** Claude's dynamic system sections can move to the first user
  message with `excludeDynamicSections`, preserving a static system prefix.
- **Nonsuppressible or authority-sensitive:** a stale fact inherited at a
  higher instruction level cannot safely be repaired by a weaker ordinary
  user message. The fork must use a same-or-higher-authority replacement,
  provider-native state diff, or be rejected as incompatible.

Cache compatibility therefore needs more than project and model. A lineage key
must cover provider, model, effort/thinking mode, harness and protocol version,
base/system prompt, appended instructions, tools, MCP/plugins/apps, permission
policy, endpoint/account/cache scope, and any provider field that occurs before
the intended breakpoint.

Direct OpenAI API callers can use provider cache-routing features, including
explicit breakpoints on supported models. YA's ordinary Codex provider uses
Codex app-server; its checked-in protocol reports cached-token usage but does
not expose a prompt-cache breakpoint or cache key. Cache warmth in that path is
an observed outcome, not a controllable guarantee.

## Prepare-only boot manager

The project-only proposal in
[cache-aware session bootstrap](cache-aware-session-bootstrap.md) prepares one
read-only provider session per compatible project/provider/configuration
lineage before any real request:

1. In an optional, per-project **prepare-only boot reuse mode**, send a
   synthetic prepare-only boot turn whose request class is stable for that
   project.
2. Load the universal global and project instruction stack, perform no
   task-specific implementation, and emit a structured readiness marker.
3. Fork the prepared provider prefix for a new user session.
4. Apply current environment/freshness state and enabled YA context.
5. Deliver the user's opening request verbatim.

The proposed prepare-only boot prompt shape is:

```text
Get ready for a <request class> request to follow. Read the applicable global
and project instructions and complete required session boot preparation. No
task request has been supplied yet: do not modify the project or invent
task-specific work. Report readiness through <structured boundary>.
```

`<request class>` is project-configurable and defaults to
`research or implementation`. It is part of the compatibility/cache-lineage
key: changing it creates a different manager. A narrower class such as
`research` may legitimately activate a coarse project policy earlier, while
the broad default can promise only universal boot. Neither form may claim that
request-dependent action triggers have fired before the request exists.

This form can serve unrelated future requests in the same project. It cannot
preload a request-dependent policy file, because the action trigger is not
known until the opening request exists. Its value is reduced latency and
cached-input billing within the provider TTL; a native fork alone does not
prove either result.

The manager must be bounded, read-only after readiness, default-off, and
discarded when any lineage key or instruction hash changes. It must not keep a
provider process alive indefinitely merely to speculate on a future hit.

## Request-conditioned boot compiler

A distinct, task-bound proposal aims to make the *full applicable boot* behave
as though it remained in context after native compaction. It addresses the
case where a compacted agent reasonably believes it already read `RESEARCH.md`,
`RUNS.md`, or another routed policy because a lossy summary retains fragments,
while only directly loaded AGENTS text is reconstructed exactly.

The **request-conditioned boot compiler** has this shape:

```text
request + project
  -> prepare-only analysis agent
  -> task-specific compiled AGENTS snapshot
  -> real task session
```

The analysis agent receives the request, follows the root routing rules, reads
every policy and project source that the request activates, performs no task
implementation, and emits a structured manifest plus compiled instruction
text. YA starts the real target session only after validating that boundary.

The fidelity-first baseline includes the full activated policy bodies, with
source boundaries and content hashes, in the compiled snapshot. This lets the
real session treat those policies as present AGENTS material across native
compaction instead of relying on a repeatedly summarized historical read.
Protecting a larger instruction scope makes optimization of the boot hierarchy
more urgent because every retained byte reduces usable task context and can
increase compaction frequency. Model-, project-, and request-class-specific
instruction ablation belongs to the governing instructions project (for the
initial use case, Sol and `~/agents`), not to YA. YA should expose the context,
compaction, latency, and provider-usage evidence that such careful experiments
need without deciding which policy is safe to remove.

### What a temporary AGENTS file proves

Pinned Codex `rust-v0.147.0` makes a narrow proof of concept possible:

1. Materialize compiled text at a path Codex will select as AGENTS input.
2. Start the real thread and require its `instructionSources` response to name
   that path before deleting the temporary source.
3. Keep the thread's environment selection fixed.

The live thread retains the creation snapshot after the file disappears, and
native compaction re-injects that cached text. Deletion is therefore cleanup,
not retirement. If the user starts an unrelated task in the same live thread,
the request-conditioned policy remains active. A cold resume, root fork, or
environment-selection change reloads disk state and can remove it. YA would
need to persist the compiled artifact in app data and deliberately
rematerialize or replace it for every legitimate continuation.

A project-root temporary file is unsuitable as the production mechanism:

- `AGENTS.override.md` wins over `AGENTS.md` in the same directory rather than
  supplementing it, so the compiled file would have to preserve the governing
  original text itself;
- every sibling thread launched during the file's lifetime can ingest the
  task-specific policy;
- a crash can strand the shared override; and
- YA-managed project-directory writes require the repository's explicit
  storage opt-in and remain the wrong default for context plumbing.

Process-local isolation is safer. YA currently launches one Codex app-server
child per active session, and its sandbox path already bootstraps a private
per-session `CODEX_HOME`. A prototype could place a compiled global
`AGENTS.override.md` in such a retained private home, including the original
global instructions it shadows, while continuing to load project AGENTS from
the real cwd. This avoids sibling and project-file races, but it also changes
where Codex stores credentials, config, skills, and rollout history; durable
resume and discovery must be designed rather than inferred from the sandbox
implementation.

The preferred provider contract is an explicit per-thread user-instructions
input that feeds Codex's `AgentsMdManager` and persists as the thread's AGENTS
world-state snapshot. The current app-server `thread/start` schema has
`baseInstructions` and `developerInstructions`, but no such user-instructions
field. Replacing base instructions is unsafe, and permanent developer
instructions have the same stale-task problem. An upstream field or equivalent
YA-owned process-local provider is therefore the clean implementation path.

This compiler is not the reusable prepare-only boot manager above. It sees the
actual request, pays an extra analysis turn, and binds its output to one task
lineage. It is also a concrete implementation candidate for the protected
compaction capsule below, provided task completion and unrelated-request
transitions start a clean session or explicitly retire the compiled state.

### Optional `~/agents` launch integration

The initial integration target is a seamless personal launch path for an
operator who normally selects one flagship model, or one of a small pair, for
each harness. It is opt-in and inert when `~/agents` is absent; the broader YA
user base need not install or understand that instruction corpus.

The compilation boundary is a harness × model × effort profile, optionally
refined by project, request class, or one actual request. `~/agents` owns which
policy sources and model-specific corrections belong in the profile. YA owns
putting the compiled bytes into what the selected harness treats as its
authoritative global `AGENTS.md` world-state and verifying what happens at
compaction, resume, fork, and changed environment selection. The corresponding
deferred compiler/install work is tracked in the
[`graehl/agents` durable-boot gap](https://github.com/graehl/agents/blob/master/gaps/agent-specific-durable-boot-compilation.md).

Supported activation shapes may differ by harness:

- install the generated flagship profile into the harness's normal global
  new-session slot; source changes then require reinstall, and status should
  detect stale source hashes rather than relying only on operator memory;
- pass a generated boot path through a supported launch argument or environment
  variable, which permits clean profile switching; or
- write the canonical slot just in time for launch when the harness is verified
  to snapshot those bytes into its durable session cache.

These are alternatives, not a portability promise. Before restoring a
temporary slot, establish whether later compaction reconstructs from the
captured bytes or rereads the live path. Preserve and restore every prior
target, keep generated artifacts and manifests in YA/app or instruction-repo
state rather than the selected project, and test each adapter in a synthetic
home. The installed-profile path is intentionally allowed: for a stable
flagship choice, reinstalling after instruction changes may be simpler and more
reliable than a per-launch override.

## Protected compaction capsule

A second proposal addresses request-conditioned compaction fidelity. A
**protected compaction capsule** is replaceable current-task state, not a
permanent instruction block and not a reusable template for arbitrary future
requests.

The distinction from the project-ready manager is load-bearing:

- **Project-ready prefix:** produced before the opening request and reusable by
  unrelated requests under the same compatible project lineage.
- **Request-conditioned capsule:** produced after a request and its scoped
  policy activation; valid only while that task remains active. A fork may
  reuse it only for an explicit continuation or descendant of that task.

Users legitimately put an unrelated fresh request into a long session. Cached
input can make that convenient and cheap enough, and opening another session
still has interaction cost. A request-conditioned capsule must therefore never
promote the first request, or its implementation plan, into system/developer
instructions that survive forever. Once satisfied, that request is historical
context. A fresh user request must be able to supersede it normally, and a
later compaction should retire obsolete task detail.

YA also cannot infer the end of request-dependent boot from tool activity. An
agent normally moves directly from reading triggered instructions into
implementation; reads, plans, and edits do not expose a reliable semantic
boundary. Automatic “capture after the boot reads” is therefore outside the
contract.

Only explicit boundaries are candidates:

- a separate request-analysis-only turn that receives the actual request,
  reads required policies, performs no implementation, and emits a structured
  checkpoint before YA sends a continue/execute turn;
- a user-invoked checkpoint or fork that declares the current task lineage;
  or
- YA-owned compaction of an already-active task, where the capsule replaces
  prior task state instead of becoming an additional permanent instruction.

The first choice costs an extra turn and changes ordinary agent behavior, so it
requires an on/off quality and latency comparison. Without one of these
boundaries, YA should use native compaction rather than guess.

The capsule should not duplicate sources that the harness already reconstructs
exactly, such as Codex's combined AGENTS state or Claude's project-root
CLAUDE.md. It should preserve the material native compaction would otherwise
summarize: the active request's load-bearing intent, active governed-policy
excerpts, source hashes, ruled-out interpretations, progress/status, and
required freshness checks. Completed requests must be labeled completed,
rather than restated as commands.

A model-written prose summary alone is not a fidelity guarantee. A safer
capsule combines:

- deterministic verbatim extraction for exact rules, paths, user constraints,
  and acceptance conditions;
- structured source/hash/activation metadata;
- a concise synthesized explanation for task state and rationale; and
- validation that every declared exact source still matches before reuse.

Exact task material needs a provider-supported *replaceable compaction*
placement. Permanently appending it to Claude's system prompt or Codex
`developerInstructions` would create the stale-task failure above. Those roles
remain candidates for project-stable YA context, not for a task capsule.

- **Claude:** `DISABLE_AUTO_COMPACT=1` can let YA schedule an explicit
  compaction boundary, but YA still needs a supported way to install a
  replaceable capsule or successor context. A new fork/session with a handoff
  message is not automatically compaction-protected.
- **Codex:** native compaction reconstructs world state but its compaction item
  is opaque. The current app-server schema exposes `developerInstructions`,
  but that is unsuitable for an obsolete task unless start/resume/fork can
  replace it safely. Codex auto-compaction cannot be disabled in the pinned
  runtime, so YA must also act with enough headroom and retain native
  compaction as a backstop.
- **Unverified providers:** do not label a capsule protected until a focused
  compaction test establishes replacement, retirement, role, and visible
  transcript behavior.

YA-driven compaction must run early enough to finish before native compaction.
It cannot guarantee interception if one huge tool result jumps across the
threshold. The protocol needs a conservative provider-specific margin, an
atomic “capsule committed” boundary, and a safe fallback to ordinary native
compaction when interception loses the race.

## Task transitions and fresh-session access

A reusable project-ready prefix offers a clean session without giving up the
benefit of a stable cached project boot. Product UX should make that route at
least as easy as continuing an unrelated request in the current session.

YA already has an optional **Queue as New Session Shortcut** `+` control in an
existing session's composer. Despite the internal `shortcut` name, it is a
visible button; `MessageInput` currently has no dedicated keyboard accelerator
for that action. A future accelerator should invoke the same Project Queue
operation, avoid the occupied `Ctrl+Enter` delivery binding and other existing
composer chords, and appear in the button tooltip and keyboard-shortcuts help.
The chord remains an open UI decision.

## Implications for AGENTS authors

Repeated compaction favors a small, exact routing layer plus deliberately
reloadable policy over either extreme of one enormous protected prompt or
unguarded one-time reads.

- Put action-time read triggers in the always-loaded root instruction source.
  Name the governed action and source path so the trigger remains useful after
  surrounding rationale has been summarized away.
- Do not phrase a load-bearing trigger as a once-per-session boot step when the
  governed action can begin or continue after compaction. Require a current
  read at the action boundary, or an explicit post-compaction check where the
  harness exposes that boundary.
- Treat the trigger and the routed file as separate context objects. Exact
  survival of `AGENTS.md` establishes only that the instruction to read a file
  survived; it does not establish that an earlier read of that file did.
- Keep authoritative detail in one routed source. A summary or capsule should
  carry the source path, hash, applicability, and essential exact constraints,
  not become a silently divergent second policy document.
- Put the most load-bearing text first in sources that a harness may truncate
  or cap, such as invoked Claude skill bodies.
- Use executable hooks or permission policy for invariants that must be
  enforced regardless of model memory. `AGENTS.md` and `CLAUDE.md` shape model
  behavior; neither is an enforcement boundary.
- At an explicit handoff or YA-owned compaction, preserve user constraints and
  acceptance conditions verbatim where their exact wording matters. Mark
  completed requests as history so repeated summaries do not turn them back
  into standing commands.

These rules reduce degradation but cannot make an opaque provider summary
auditable. A policy whose faithful presence is critical still needs a fresh
read, protected provider source, or executable gate.

## Freshness repair after fork

Every reused prefix needs a fresh suffix before work begins. The preferred
order is:

1. provider-native current-world-state reconstruction or diff;
2. same-authority replacement of inherited dynamic instructions;
3. an explicit lower-authority stale-state notice plus mandatory tool check,
   only where the higher-level instruction allows that correction; or
4. reject the fork and start cold when no sound correction path exists.

The suffix should state that cached dates, cwd, repository state, permissions,
tool inventory, and host facts are stale unless the provider just refreshed
them. “Check live state before relying on it” is a repair instruction, not
proof that the stale higher-authority statement has been neutralized.

## Validation gates

No boot or capsule option should ship without contrastive current-versus-new
evidence for:

- first-response latency and total startup latency;
- uncached, cache-write/cache-creation, and cache-read input tokens;
- warm, expired, changed-instruction, changed-tool, and changed-permission
  cases;
- exact preservation of activated policy constraints across repeated
  compactions;
- correct refresh of date, cwd, repository state, permissions, and tools after
  fork;
- a large single-turn jump that races the proposed compaction threshold;
- visible and provider-persisted transcript shape;
- parity of provider-owned goal, mode, plan, memory, and other explicit state
  between native compaction and any fork-summary approximation;
- classification and parity of every slash command's prompt, local action,
  hook, setting, and provider-state effects; and
- quality/adherence with the feature off and on.

YA's current Cache Billing view has known evidence gaps, so an experiment must
record provider-reported usage directly rather than infer a hit from matching
fingerprints or an empty diagnostics view.

## Primary evidence

Provider documentation:

- <https://learn.chatgpt.com/docs/agent-configuration/agents-md>
- <https://developers.openai.com/api/docs/guides/compaction>
- <https://developers.openai.com/api/docs/guides/prompt-caching>
- <https://code.claude.com/docs/en/context-window>
- <https://code.claude.com/docs/en/commands>
- <https://code.claude.com/docs/en/slash-commands>
- <https://code.claude.com/docs/en/hooks>
- <https://code.claude.com/docs/en/agent-sdk/slash-commands>
- <https://code.claude.com/docs/en/memory>
- <https://code.claude.com/docs/en/prompt-caching>
- <https://code.claude.com/docs/en/agent-sdk/modifying-system-prompts>
- <https://code.claude.com/docs/en/env-vars>
- <https://code.claude.com/docs/en/settings>

YA implementation entry points:

- `packages/shared/src/agent-context.ts`
- `packages/server/src/sdk/providers/claude.ts`
- `packages/server/src/sdk/providers/codex.ts`
- `packages/server/src/sdk/providers/codex-oss.ts`
- `packages/server/src/sdk/providers/gemini.ts`
- `packages/server/src/sdk/providers/gemini-acp.ts`
- `packages/server/src/sdk/providers/grok-acp.ts`
- `packages/server/src/sdk/providers/opencode.ts`
- `packages/server/src/sdk/providers/pi.ts`
- `packages/server/src/session-sandbox.ts`

Pinned Codex evidence:

- `references/codex/codex-rs/core/src/agents_md_manager.rs`
- `references/codex/codex-rs/core/tests/suite/agents_md.rs`

## Open decisions

- Which provider-native role should own a protected capsule without changing
  the first-party harness's safety or tool contract?
- Is a replaceable capsule deterministic, hybrid, or model-synthesized with a
  verifier, and what failure stops reuse?
- Which active supplements warrant exact excerpts rather than a source hash and
  a mandatory reread?
- How much headroom is sufficient to beat native compaction for each provider?
- Can Claude's Git snapshot be removed without losing workflow behavior users
  rely on, and should dynamic system sections move to user authority?
- Can Codex gain a granular dynamic-context control instead of suppressing its
  entire environment block?
- What cache-hit and adherence evidence would justify making either mode more
  discoverable while it remains default-off under vanilla defaults?
- Which non-conflicting accelerator should queue the current draft as a new
  project session?
