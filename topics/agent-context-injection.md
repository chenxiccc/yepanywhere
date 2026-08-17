# Agent Context Injection

> Agent context injection is the provider-specific contract for placing YA,
> harness, and project instructions into model context, preserving designated
> sources across compaction, and refreshing mutable facts without destabilizing
> reusable prompt prefixes.

Topic: agent-context-injection

Status: current provider placement and compaction contract. Unimplemented boot
managers, request-conditioned compilers, protected capsules, and their full
evidence trail live in
[`agent-context-injection.sketches.md`](agent-context-injection.sketches.md).

Related topics: [cache-aware session bootstrap](cache-aware-session-bootstrap.md),
[provider context economics](provider-context-economics.md),
[emulated slash commands](emulated-slash-commands.md),
[injected-message visibility](injected-message-visibility.md),
[synthetic-turn injection](synthetic-turn-injection.md), and
[federated super sessions](federated-super-sessions.md).

## Scope and vocabulary

This topic uses *agent context injection* rather than *prompt injection*. The
latter commonly names an adversarial instruction attack; this topic is about
intentional context supplied by YA or a provider harness.

Provider context sources have different durability and authority:

- base/system instructions and host-appended system/developer instructions;
- project instructions discovered by a harness, such as `AGENTS.md` or
  `CLAUDE.md`;
- mutable world state such as cwd, date, shell, permissions, and tools;
- ordinary user text plus any YA wrapper placed at user-message authority; and
- tool-read routed policy such as `RESEARCH.md`, `RUNS.md`, and topic docs.

For each source, distinguish exact reconstruction from current source, exact
carry-forward, bounded provider reinjection, lossy conversation summary, and a
later action-triggered reread. “The model probably remembers it” names none of
these mechanisms.

## Current YA placement

`buildEffectiveAgentContext` in `packages/shared/src/agent-context.ts` composes
enabled `[Client capabilities]` fragments before the free-form
`[Global instructions]` block. The server passes that result as
`globalInstructions`; provider adapters decide where it enters model context.

| Provider path | Placement | New process | Resumed process |
|---|---|---:|---:|
| Claude and Claude Ollama | `systemPrompt` preset `append` | yes | yes |
| Codex app-server | `[Global context]` prefix on first ordinary user message | yes | no |
| Codex OSS and legacy Gemini | same ordinary-user prefix | yes | no |
| Pi, OpenCode, Grok ACP, Gemini ACP | same ordinary-user prefix | yes | first message after process launch |

Shared-hosted provider processes also receive `AGENT_LAUNCHER`,
`AGENT_LAUNCH_HARNESS`, `AGENT_LAUNCH_MODEL`, and `AGENT_LAUNCH_EFFORT`. The
latter two record the explicit initial selections and do not change after live
model or effort updates. These markers are launch facts only; they do not alter
instruction placement or implement a compiled boot. They are unprefixed because
the shared child filter strips `YEP_*` — see `topics/ya-env-vars.md`.

The non-Claude prefix has this provider-facing shape:

```text
[Global context]
<effective agent context>

---

<actual first user message>
```

YA's optimistic live echo normally hides the adapter echo as a duplicate. That
presentation behavior does not remove the wrapper from provider history or
raise its authority. The current placement discrepancy and Settings wording
remain tracked in [`gaps/confusing-settings.md`](../gaps/confusing-settings.md).

## Provider compaction contracts

### Codex

Pinned Codex source combines host-provided global instructions and discovered
project `AGENTS.md` files into one user-role `AgentsMdState` world-state
section. Manual and pre-turn compaction clear its reference so the next turn
injects the full cached state; mid-turn compaction inserts it before the last
real user message.

That cache is a process/environment-selection snapshot, not a live file
watcher. Ordinary turns do not reread changed or removed files. A cold root
resume, root fork, or changed environment selection loads current sources and
can emit a replacement/removal notice. This is exact reconstruction of the
selected AGENTS snapshot at contextual user authority; it does not protect
arbitrary policy files that AGENTS caused the model to read later.

Codex also rebuilds contextual environment state for each step. In the pinned
source it covers cwd, shell, date, timezone, filesystem and permission context,
and subagent information. `include_environment_context = false` suppresses the
bundle as a whole. No normal model-context injection of Git HEAD/status was
found.

Codex has no verified auto-compaction disable switch. Its default soft limit is
at most 90% of the model context window; setting the limit to zero compacts
immediately. YA may request earlier compaction, but one large turn can still
cross both a soft threshold and the hard context bound.

### Claude Code

Claude Code natively discovers `CLAUDE.md`, not `AGENTS.md`. A repository may
import or symlink AGENTS content from its root CLAUDE file, after which the
CLAUDE loading contract applies.

Anthropic documentation says compaction leaves the system prompt and output
style unchanged; reloads project-root `CLAUDE.md`, unscoped rules, and auto
memory; reloads path-scoped/nested instructions only after a matching file
read; reinjects invoked skills within token caps; and summarizes ordinary
conversation and tool reads. It does not establish the same reinjection
guarantee for user-global CLAUDE.

YA passes `globalInstructions` through the Agent SDK's `claude_code` preset
`append`, so it remains in the system prompt for new and resumed provider
processes. YA does not enable `excludeDynamicSections`. Claude supports that
option to move cwd/platform/shell/Git-presence facts to the first user message,
and separately supports `includeGitInstructions: false`, which also removes
built-in Git workflow text. Those are behavior changes, not free cache knobs.

Claude supports `DISABLE_AUTO_COMPACT=1` for manual-only compaction and
`DISABLE_COMPACT=1` for no automatic or manual compaction. Either still needs a
hard-context recovery path in any YA experiment.

### Other providers

YA's adapters establish current placement for Pi, OpenCode, Grok, Gemini, and
Codex OSS. Their native compaction, fork, and instruction-file durability have
not been verified to the Codex/Claude standard and remain unknown.

## Harness-owned explicit state

Structured state outside transcript history is model-reliable across
compaction only when all three properties hold:

1. an authoritative store independent of summarized messages;
2. fresh model injection or a mandatory model query after compaction/resume;
3. explicit replacement, completion, and clearing semantics.

### Slash commands are not one state mechanism

A `/name` surface may be fixed harness logic, a prompt-backed skill, a
provider-control state update, or a hybrid. Inventory its lasting prompt,
transcript, hook, setting, and provider-state effects separately.

Claude's `/goal`, for example, combines local status/injected turns with a
session-scoped prompt-based Stop hook and a separate evaluator call. Codex
goals are persisted thread state with app-server get/set/clear operations and
hidden model-context fragments for automatic continuation. Conversely,
Codex's `update_plan` emits a historical plan event but has no verified
current-plan world-state reinjection. Similar names do not imply similar
durability.

### Native compaction is not fork-summary compaction

Provider-native compaction can invoke harness-owned reconstruction. Forking a
transcript and asking a new session for a summary is a new-session transition.
It is equivalent only when every provider-owned goal, mode, plan, memory, hook,
and other state family has an explicit carry, replacement, or visible clearing
path.

Pinned Codex demonstrates the distinction: app-server can copy an active goal
to a fork only with `deferGoalContinuation: true`, while YA's current
`createThreadForkParams` does not set that flag. A YA fork may therefore retain
transcript history while dropping provider-owned goal state.

## Routing rules are not routed policy bodies

An always-loaded AGENTS rule can exactly survive compaction while the routed
file it caused the model to read survives only in a lossy summary. Exact
reconstruction of “read `RESEARCH.md` before research” does not prove that an
earlier `RESEARCH.md` read remains exact.

Current agent policy therefore requires routed sources to be reread at the next
governed action boundary after compaction/resume unless the harness verifiably
reconstructs the exact current packet. YA does not maintain an active
governed-supplement manifest or protected copy of arbitrary routed files.

## Cache-compatible context

Prompt-cache reuse requires exact prefixes, but correctness outranks prefix
identity. A reusable lineage would need to include provider, model,
effort/thinking, harness/protocol version, base and appended instructions,
tools, plugins/apps, permissions, endpoint/account/cache scope, and all dynamic
fields before the reuse boundary.

Dynamic facts can be omittable and tool-queryable, movable to a later message,
or authority-sensitive and unsafe to repair from a weaker suffix. Codex
app-server exposes cached-token usage but no YA-controlled prompt-cache key or
breakpoint. Cache warmth is an observed outcome, not a current control plane.

## Task transitions and fresh state

When YA reuses or forks provider history, live facts must be refreshed in this
order:

1. provider-native current-world-state reconstruction/diff;
2. same-authority replacement of inherited dynamic instructions;
3. a lower-authority stale-state warning plus mandatory tool check only when
   the higher-level source permits that correction; or
4. rejection of reuse and a cold start.

A suffix saying “check live state” is an instruction to repair, not proof that
a stale higher-authority fact was neutralized.

YA's existing **Queue as New Session Shortcut** offers a clean new session from
the current composer. It has a visible `+` control and no dedicated keyboard
accelerator. Any future chord must reuse the same Project Queue operation and
avoid existing delivery bindings.

## Implications for instruction authors

- Keep action-time read triggers in the always-loaded root source and name the
  governed action plus routed path.
- Treat the trigger and routed file as separate context objects.
- Keep authoritative detail in one routed source; summaries carry provenance
  and essential constraints, not a divergent second policy.
- Put load-bearing text first where a harness may truncate or cap reinjection.
- Use executable hooks/permissions for invariants that must hold independent of
  model memory.
- Preserve exact user constraints at explicit handoff/compaction boundaries
  where wording matters; mark completed requests as history.

## Dormant designs

YA has not implemented or approved the following mechanisms:

- [prepare-only boot manager](agent-context-injection.sketches.md#prepare-only-boot-manager);
- [request-conditioned boot compiler](agent-context-injection.sketches.md#request-conditioned-boot-compiler);
- [protected compaction capsule](agent-context-injection.sketches.md#protected-compaction-capsule);
- [active governed-supplement manifest](agent-context-injection.sketches.md#routing-rules-are-not-routed-policy-bodies);
- optional personal `~/agents` launch integration; or
- a setting enabling any of them.

The sketches companion preserves their proposed protocols, evidence notes,
validation gates, and open decisions. Those sections are candidate design, not
current behavior or authorization to implement.

## Primary evidence

Current claims are grounded in provider documentation, YA adapter code, and
the pinned Codex source under `references/codex`. Key YA entry points are
`packages/shared/src/agent-context.ts` and provider adapters under
`packages/server/src/sdk/providers/`. The detailed source list and observed
trace evidence remain in the sketches companion.
