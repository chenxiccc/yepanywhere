- grok - Grok Build ACP provider integration.
- predictive-scroll - Tool row on-demand hydration and placeholder sizing.
- stable-tool-preview-rendering - Browser preference to pre-render tool previews for stable session scrolling.
- recaps - Away-summary recap UX and simulated-helper configuration.
- emulated-slash-commands - Provider command aliases and skill-backed fallbacks.
- glossary - Project vocabulary lookup and regeneration contract.
- side-session-config - Shared helper side-session defaults and lifecycle.
- openai-compatible-helper-sessions - OpenAI-compatible helper endpoint runtime for simulated helper work.
- core-service-api - Proposal to expose YA's provider/session runtime as a headless service and extractable core for external scripts and OpenAI-style proxy clients.
- prompt-suggestions - Next-user-turn suggestion surface and native/simulated split.
- session-liveness - Provider/session cache state, stale entries, and recovery.
- pluggable-speech-recognition - YA server-routed speech backends and browser-native fallback.
- cost-efficiency - Preferring subscription/local over metered APIs; billing footgun masking.
- ya-env-vars - Catalog of YA env vars and the canonical YEP_/YEP_MODULE_
  naming conventions.
- subprocess-environment - Runtime child-environment, shell-startup, and
  hermetic subprocess-test boundaries.
- source-name-prefixes - Distinguish TypeScript module symbols from YEP_
  process environment variables and runtime globals.
- env-vars-config - Settings UI for process-start env visibility and future
  child-process override defaults.
- kzahel-disabled - Upstream-disabled feature decisions to revisit as configurable defaults.
- session-ui-customization - User-selectable visibility/enabling of advanced session controls.
- relay-origin-and-share-gating - Public relay origin allowlist and public share opt-in/privacy gating.
- session-toolbar-customization - Browser-local session composer toolbar visibility controls.
- i18n-sparse-locale-cleanup - Sparse non-English locale overlays and translation key health checks.
- session-activity-tab-title - Browser-local tab title activity indicator.
- client-session-lifecycle-store - Shared client lifecycle reducer/store for session activity indicators.
- client-session-collection-store - Normalized client session facts and list projection consistency.
- relative-filenames - Shortest-unambiguous file path display and link targets.
- rich-text-rendering - Rendered file/message/diff previews and local-link handling.
- security - YA trust-boundary contracts for local, authenticated, relay, and public surfaces.
- trusted-client-packaging - Signed/local client packaging and relay-only transport trust roots.
- message-control-steer-queue-btw-later-interrupt - Steer/queue control state, ownership normalization, and metadata contract cleanup.
- composer-bottom-bar-overflow - Narrow composer bottom-row overflow popup and control priority.
- ui-architecture - Shared rendering boundaries and anti-DOM-rewrite discipline.
- opencode-backend - OpenCode provider capability and transcript-rendering parity.
- provider-refresh - Provider upstream/source refresh triggers, probes, and due-refresh evidence.
- pi-provider - Pi installed-binary contract coverage and upstream compatibility refreshes.
- provider-model-glyphs - Compact provider/model identity for narrow status surfaces.
- graehl-ci-pre-kzahel-gate - Retired to a checkout-local note (maintainer-personal remote policy); topic string stays reserved for the existing commit series.
- claude - Claude provider control, restart/resume safety, interviews, and YA-owned process bridges.
- edit-turn - Inline editing proposal for queued/sent user turns with a visible Esc/cancel escape hatch.
- resume-compaction - Compact-before-resume choice for old or context-heavy provider sessions.
- steer-queue-provider-differences - Claude now/next/later lanes, Codex steer vs app-held queueing, and turn-end signals behind YA send modes.
- vanilla-defaults - Overarching UX theory: first-party-familiar out of the box; YA-novel user-visible behavior is configurable default-off.
- streaming-speech-capture - Client PCM capture contracts, warm-mic latency, and AudioWorklet follow-up.
- direct-xai-speech - Hosted Grok STT direct browser-to-xAI data path and explicit client key borrowing.
- mic-button-speech-ui - Mic button speech insertion, spoken commands, and streaming/batch composer behavior.
- prompt-cache-keepalive - Open-client-only provider prompt-cache warming and cost/activity bounds.
- session-list-display - Session list/sidebar badges, model glyph mapping, and the hover tooltip card.
- session-list-hidden-duplicates - Conservative duplicate-title hiding for session lists, preserving fork/helper lineage and never letting YA helper sessions hide source/current sessions.
- stream-durable-id-dedup - Stream-vs-durable message id alignment and the approx-dedup backstop (codex/opencode steer double-render).
- selection-comment-ui - Quote selected assistant output into the composer with source-block tint reminders.
- fork-from-turn - Turn-notch fork actions and server-owned fork-after-summary jobs.
- provider-fork-support - Whether Codex/Pi could implement the forkSession primitive, with per-provider enablement plans and gaps.
- transcript-display-objects - Persisted viewer-only objects anchored in transcript order.
- backward-compat - Observable and persisted surface compatibility decisions.
- provider-session-tree - Capability-gated sidebar tree for provider transcripts with parent-link branch data.
- session-retitle - Explicit title editing and user-confirmed generated retitle proposals.
- responsive-layout-gaps - Font-metric-sensitive responsive wrapping gaps and the measured layout invariants that should replace fixed pixel/rem thresholds.
- session-defaults - New-session default scoping: all-provider controls vs provider/model economics controls.
- floating-new-session-composer - Non-session-page `+` quick composer, new-session prefill, and click-time non-browser speech prewarm.
- permission-mode - Provider-independent approval preference with model-capability-gated Auto fallback.
- codex-sessions - Codex rollout storage, compression representation, and YA's durable read assumptions.
- codex-user-turn-provenance - Use Codex's persisted user-turn lifecycle to distinguish real prompts from user-role contextual response items.
- codex-metadata-scanner - Codex rollout head-metadata discovery, current cache layers, and scanner performance gaps.
- project-queue - Server-owned project-level queued messages, idle promotion, and hidden-by-default UI surfaces.
- inbox - Session-attention tiers for pending input, active work, recent activity, and unread notification state.
- session-queue-persistence - Durable server-side persistence prep for
  per-session queued messages and restart-paused recovery.
- client-global-store - Zustand-backed coarse client summary store for sessions, projects, queues, and inbox projections.
- source-control-basic-actions - Narrow Source Control page expansion with split diff, recent commits, and explicit remote actions.
- draft-attachment-staging - Draft envelope, staged attachment storage, and materialization support for composer attachments.
- inactivity-push-notifications - Default-off push settings and server-side inactive project / YA notification edges.
- client-query-controller - Source-scoped client fetch lifecycle, coverage-aware
  dedupe, and retained summary feed queries.
- session-initial-load-performance - Long-session initial render progress,
  chunking, and transcript mount cost experiments.
- client-route-retention - Bounded browser-side route/view retention for
  instant back/forward returns without unbounded transcript caching.
- turn-rail-marker-layout - Right-scrollbar turn marker hit targets, previews,
  and bottom-bar position-age hints.
- remote-hosted-compatibility - Coarse hosted remote UI / YA server
  compatibility level, starting with recommended level 10 for the first
  rollout.
- codex-session-index-memory - Codex summary-index cold parse memory spikes,
  entry cache retention, and instrumentation.
- summary-parser-worker-isolation - Worker child-process lifecycle,
  parent-side parse coordination, and duplicate large transcript parse
  reduction.
- project-queue-reorder-and-titles - Project Queue project-local
  reprioritization and cache-backed target session display titles.
- session-dom-linger-speedup - Bounded hidden-DOM linger for immediate
  session back/reselect returns.
- public-share-content-censorship - Content-aware censorship proposal for
  public transcript bodies that may include Read/Edit snippets and command
  output secrets.
- bash-result-contract - Provider-normalized Bash result fields for output,
  return code, timing, and empty-output rendering.
- stream-persisted-render-parity - Strong convergence for live items with
  durable counterparts, with bounded optimistic/live-only detail at the tail.
- provider-authoring - Map for adding a new agent provider to the harness
  (interface, reader, normalization, parity, snooping JSONL).
- browser-profile-devices - Browser profile identity, automated browser
  grouping, and stale non-push profile retention.
- session-detail-data-layer - Canonical client session detail store/reducer
  between provider transcript inputs and transcript DOM rendering.
- remote-client-ci-publish - Opt-in CI publish proposal for the hosted remote
  client (repo-variable-gated GitHub Actions to a personal Pages repo).
- thinking-expand-latest-only - Thinking auto-expand policies and the
  thought-toggle right-click gesture (registered retroactively; series
  began at fd47ecb2).
- composer-model-visibility - Provider/model identity echoed adjacent to
  composers (New Session chip, floating composer chip; the session-composer
  float was removed as redundant with the header badge).
- provider-output-contract - Single spec for normalized provider output
  (message envelope, tool results, status, lineage links); named TS types
  as the type definition, validation kept off hot paths.
- provider-runtime-status - Live provider retry/failure status surfaced from
  provider streams into YA process/session UI state.
- client-source-runtime-topology - Source-runtime context and session-detail
  coordinator extraction for client data-flow cleanup.
- workstreams - YA-managed lanes for topic work in one repository: per-lane
  queues over real checkouts syncing through the shared upstream.
- session-media-handles - Server-owned media handles replacing inline base64
  transcript payloads in retained client state.
- source-transport - Source-bound transport facade for localhost, plain
  multiplex WebSocket, and secure/relay modes with visible channel status.
- session-exit-navigation-latency - Large transcript routes must not delay
  first paint of Settings or other lightweight routes when leaving a session.
- typescript-module-boundary-refactor - Tracking-first refactor series for
  extracting large TypeScript/TSX files along existing module boundaries.
- server-capabilities - Shared registry and lifecycle policy for `/api/version`
  capability strings and transitional compatibility gates.
- session-id-remap - Public remap event and client summary-store merge for
  startup-time temporary session IDs that later canonicalize.
- session-compact-tail-pagination - Session-detail `tailCompactions`
  semantics: include exactly the requested number of compact boundary markers
  once they exist, avoiding the exactly-two-boundary full-history
  discontinuity for the default compact tail.
- memory-growth - Browser/client memory-growth investigations and bounded
  transcript load contracts for large provider sessions.
- transcript-virtualization - Viewport-bounded transcript rendering, native
  content visibility, and first-traversal scroll stability.
- codex-code-mode-render-convergence - Shared rollout-recoverable semantic
  actions for GPT-5.5 and GPT-5.6 command rendering and explored grouping.
- windows-codex-cli-detection - Windows Codex auto-discovery across PATH
  shims, desktop binaries, and fallback installs.
- portable-transcript-compiler - Stable server ingest, bounded transcript
  envelopes, and a shared semantic projection compiler for web and native
  renderers.
- provider-child-sessions - Provider-launched delegated work discovered from
  provider persistence and nested beneath its canonical YA parent session.
- older-claude-models - Default-off server registry and grandfathered custom
  selections for previous provider model versions.
- host-awake - Server-owned, process-lifetime idle-sleep inhibition with an
  optional macOS closed-lid-on-external-power strategy.
- host-identity - Optional server-owned emoji marker for connected headers and
  browser-tab titles, hidden against older servers.
- tooltip-interactions - Shared native/themed tooltip presentation, pointer-rest
  delay, warm adjacent scanning, and future rendered hidden-tail previews.
- session-summary-fidelity - Bounded session list projections, complete-index
  isolation, and partial-observation nondowngrade rules.
- agents-activity-preview - Optional bounded multi-session activity previews
  for active and recently idle process cards on Agents.
- interactives - Zero-setup container for agent-built project web apps:
  opinionated template, committed project files, registry, icon links,
  YA-server-only reach (relay, or auto Cloudflare tunnel when enabled),
  and a meta-UI comment-to-agent channel.
- rich-interviews - Banked: multi-round structured-input interview flows;
  YA renders declared formats inline; revisit atop interactives machinery.
- server-plugin-arch - Banked no: settings-gated loadable server plugins;
  monolith convenience wins absent a contributing community.
- project-settings-overrides - Banked seed: project-scoped settings
  overriding global; easy mechanically, painful to visualize; no current use.
- composer-recall-drawer - Ctrl+Up prefix-match history drawer folding up
  from the composer (reuses isearch/UserTurnNavigator machinery); bundled
  enablement change makes !! execution and the recall drawer always-on,
  with only the "!! Commands" sidebar section opt-in. Vanilla Defaults
  amended with an established-convention carve-out to allow it.
- settings-search - live substring filter over the Settings UI: shared
  SettingsItem/SettingsSection row layer, operable-in-place results with
  highlighted matches and jump links, default-off "Match values" toggle.
