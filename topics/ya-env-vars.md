# YA environment variables

> The environment variables Yep Anywhere reads, and the `YEP_` naming
> conventions that distinguish YA-private secrets (consumed and stripped
> on load) from plain YA config toggles and inherited system vars.

Topic: ya-env-vars

`packages/server/src/config.ts` (`loadConfig`) is the implementation source of
truth for the full set and exact defaults; this doc defines the intended naming
contract and curates the *meaningful* operator-facing vars. Deep tuning knobs
(session-index timings, codex rescan intervals, cache TTLs) live only in
`config.ts`.

The read-only **Environment variables** Settings pane is the operator-facing
inventory. It defaults to set variables only and can switch to all documented
variables. Its registry includes operator inputs read outside `loadConfig`,
while excluding ordinary inherited system variables and YA-private launch or
child-session markers. Secret values are redacted on the server before the
report reaches a browser. Names ending in `_KEY`, `_TOKEN`, `_SECRET`, or
`_PASSWORD` are always secret even if a future registry descriptor incorrectly
opts out. A set secret may show only its final four characters; the full value
never enters the report.

The development wrapper's `YEP_DEV_WRAPPER_*` and Codex lifecycle host's
`YEP_CODEX_RUNTIME_*` variables are private control-plane inputs, not operator
settings. Startup harvests them for their owning modules and removes them from
ambient child inheritance.

Related topic: [subprocess environment boundaries](subprocess-environment.md)
defines child propagation, shell-startup, and hermetic-test rules.

The canonical product prefix is **`YEP_`**. Existing `YA_*` and
`YEP_ANYWHERE_*` names are compatibility aliases, not naming precedents. At the
startup normalization boundary:

- a canonical `YEP_*` value wins when both canonical and legacy names are set;
- a legacy value is copied to its canonical name only when the canonical name
  is absent;
- legacy names are removed from `process.env`, so diagnostics and child
  environments see only canonical names;
- legacy module spelling is flattened directly to the canonical uppercase
  prefix: `YA_stt__XAI_API_KEY` becomes `YEP_STT_XAI_API_KEY`. There is no
  intermediate `YEP_stt__*` compatibility name.

`packages/server/src/startupEnv.ts` implements this normalization before the
rest of the server module graph is evaluated.

## Compatibility renames

| Legacy input | Canonical runtime name |
|---|---|
| `YEP_ANYWHERE_DATA_DIR` | `YEP_DATA_DIR` |
| `YEP_ANYWHERE_PROFILE` | `YEP_PROFILE` |
| `YA_VOICE_BACKENDS` | `YEP_VOICE_BACKENDS` |
| `YA_DEFERRED_JOIN_WINDOW_S` | `YEP_DEFERRED_JOIN_WINDOW_S` |
| `YA_COMPOSE_ANCHORS` | `YEP_COMPOSE_ANCHORS` |
| `YA_stt__XAI_API_KEY` | `YEP_STT_XAI_API_KEY` |
| `YA_stt__DEEPGRAM_API_KEY` | `YEP_STT_DEEPGRAM_API_KEY` |
| `YA_stt__SHARE_XAI_KEY_WITH_CLIENTS` | `YEP_STT_SHARE_XAI_KEY_WITH_CLIENTS` |
| `YA_CODEX_DISABLE_LIVE_DELTAS` | `YEP_CODEX_DISABLE_LIVE_DELTAS` |
| `YEP_YA_CLIENT_BASE_URL` | `YEP_CLIENT_BASE_URL` |
| `YEP_PUBLIC_SHARE_VIEWER_BASE_URL` | `YEP_CLIENT_BASE_URL` |
| `YEP_PUBLIC_SHARE_ORIGIN` | `YEP_CLIENT_BASE_URL` |
| `YEP_ANYWHERE_ORIGINAL_BASH_ENV` | `YEP_ORIGINAL_BASH_ENV` |
| `YEP_ANYWHERE_ALLOW_SUSPICIOUS_HOME` | `YEP_ALLOW_SUSPICIOUS_HOME` |
| `PI_PATH` | `PI_EXECUTABLE` |

The startup pass applies this table once: canonical wins, otherwise the first
set legacy value supplies it, and every listed legacy key is deleted.

## Naming conventions

- **`YEP_<MODULE>_<NAME>` — YA-private module env, consume-and-strip.** Read
  for a YA subsystem, then **deleted from `process.env` on load** so it can
  never leak into a spawned child CLI (`harvestYaModuleEnv` in
  `packages/server/src/yaModuleEnv.ts`; read via `getModuleEnv(module)`).
  Private modules use explicitly registered prefixes such as `YEP_STT_`,
  `YEP_CODEX_RUNTIME_`, and `YEP_DEV_WRAPPER_`;
  generic `YEP_*` names cannot be parsed as module-scoped because ordinary
  config toggles use the same separator. This protects credentials whose bare
  names another vendor's CLI would honor — see the billing footgun in
  [cost-efficiency.md](cost-efficiency.md). Use the module prefix for
  module-scoped knobs that sit beside those credentials, too, so one subsystem
  does not grow two YA env families.
- **Vendor-named fallback secrets** — accepted only where explicitly
  documented. `XAI_API_KEY` is accepted as a convenience fallback for Grok STT,
  then deleted from `process.env` during config load. `YEP_STT_XAI_API_KEY`
  takes precedence and is preferred because it isolates STT billing from Grok
  Build provider billing.
- **`YEP_<NAME>` — YA-specific config toggle (non-secret).** Meaningful only
  inside YA; not a credential, so it is read normally (not stripped) and
  has no `__`. New YA-only toggles should take this prefix.
- **`YA_*` / `YEP_ANYWHERE_*` — legacy compatibility aliases.** Normalize to
  `YEP_*` at startup, with canonical values winning, then remove the aliases
  from `process.env`.
- **Unprefixed** (`PORT`, `VOICE_INPUT`, `ENABLED_PROVIDERS`, `LOG_*`,
  `WHISPER_*`, …) — historical YA config that predates the product prefix.
  This migration does not rename them merely to maximize prefix coverage.

## Child launch markers

`YEP_AGENT_HARNESS` identifies the harness family launched by YA's shared
provider host (`claude`, `codex`, `gemini`, `grok`, `opencode`, or `pi`).
`YEP_AGENT_INITIAL_MODEL` and `YEP_AGENT_INITIAL_EFFORT` record the explicit
model and effort selected at that launch; they are omitted when YA has no
explicit value and intentionally remain unchanged after a live model or effort
switch. The host replaces inherited values at the worker boundary and applies
the same launch facts to remote-provider environments. These are trusted
child-session outputs, not operator inputs. `AGENTCTL_SESSION_ID` remains the
canonical YA session-id marker: a resume may have it at launch, while a new
session receives it later through the session environment bridge.

`YEP_SESSION_WAKE_URL` and `YEP_SESSION_WAKE_TOKEN` are YA-owned outputs for a
supervised provider session, not operator inputs. The URL is an opaque,
session-specific POST target; the bearer token authorizes only that session's
wake route. Both are published beside `AGENTCTL_SESSION_ID` after the canonical
session id is known and remain inert while wake delivery is disabled. The token
must never be logged. A YA server launched from such a child shell strips both
markers during config load; they are parent-session capabilities, not config
to relay into the new server's provider children.

`YEP_CLAUDE_GATEWAY=1` is a YA-owned output marker injected into both the
Claude SDK flag-settings environment and the spawned child environment for
`claude-gateway` launches. It distinguishes that provider route from regular
Claude without guessing from `ANTHROPIC_BASE_URL`; it does not identify which
Anthropic-compatible gateway implementation serves the endpoint and is not an
operator setting.

`YEP_COPILOT_API=1` is the narrower implementation marker. YA injects it only
after the configured gateway's `/v1/models` response explicitly advertises
`X-Copilot-API: 1`, and clears the learned identity when the Gateway URL
changes. Model names, ports, vendors, and generic endpoint compatibility never
imply it.

Gateway launches also inject `CLAUDE_CODE_*` narrowings that are not YA
variables but are decided by YA per launch (`gatewayEnvironment()` in
`packages/server/src/sdk/providers/claude-gateway.ts`). `ENABLE_PROMPT_CACHING_1H`
and `CLAUDE_CODE_MAX_RETRIES` in `env-filter.ts` follow the same rule: YA
supplies a default only when the ambient environment has none, so an operator
export in YA's own environment always wins. That read-then-default direction is
the contract — a YA default here must never overwrite an explicit operator
value, because the child has no other way to express one.

## Meaningful variables

### Ports & instance
| Var | Meaning |
|-----|---------|
| `PORT` | Base port (default 3400). Main = PORT+0, maintenance = PORT+1, vite = PORT+2. |
| `MAINTENANCE_PORT` | Override maintenance port (0 disables). |
| `VITE_PORT` | Override vite dev port. |
| `YEP_PROFILE` | Profile suffix → `~/.yep-anywhere-<profile>/`. |
| `YEP_DATA_DIR` | Full data-dir path override. |
| `CLAUDE_CONFIG_DIR` | Claude Code config dir (sessions scanned from `<dir>/projects/`). |

### Development & UI testing
| Var | Meaning |
|-----|---------|
| `VITE_DISABLE_ONBOARDING` | `true` suppresses the first-run onboarding dialog in the standard client build. Intended for fresh dev and screenshot servers; evaluated by Vite at build/dev-server startup. |
| `VITE_DISABLE_CLI_UPDATE_NOTIFICATIONS` | `true` suppresses CLI update dialogs in the standard client build (currently the Codex CLI prompt). Intended for dev and screenshot servers; evaluated by Vite at build/dev-server startup. |

### Providers & features
| Var | Meaning |
|-----|---------|
| `ENABLED_PROVIDERS` | Comma list of exposed providers (empty = all). |
| `VOICE_INPUT` | `false` disables the mic button server-side. |
| `PI_EXECUTABLE` | Full path to the pi CLI executable for the pi provider. `PI_PATH` is accepted as a legacy alias when `PI_EXECUTABLE` is unset. |
| `YEP_VOICE_BACKENDS` | Explicit local/test speech backends (`ya-whisper`, `ya-parakeet`, `ya-nemo`, `ya-dummy`). Cloud backends auto-enable on key presence instead. |
| `YEP_DEFERRED_JOIN_WINDOW_S` | Max seconds between consecutive compose times for queued-while-busy turns to join into one `--------`-joined provider turn at a delivery boundary. Default 0: never join — one verbatim turn per boundary. Server setting `deferredJoinWindowSeconds` overrides ([compose-time-context-anchors](compose-time-context-anchors.md)). |
| `YEP_COMPOSE_ANCHORS` | `1` prepends `(Ns ago)` / `(Ms later)` staleness anchors to delivered queued turns; the first anchor quotes the assistant output the composer had last seen (`had seen: "…"`). Default off: queued text reaches the provider verbatim. Server setting `composeAnchorsEnabled` overrides. |
| `YEP_TURN_TIMESTAMPS` | `before` or `after` adds an absolute `[sent <ISO-8601>]` compose-time marker to provider-bound user turns, in the provider session-jsonl timestamp format; the client hides it in presentation. Experimental, default off. Server setting `turnTimestamps` (Message Delivery pane) overrides ([compose-time-context-anchors](compose-time-context-anchors.md)). |
| `YEP_SESSION_WAKE_BASE_URL` | HTTP(S) server base injected into remote provider sessions for session-wake callbacks. Required when the child cannot reach the ordinary localhost listener or cannot trust YA's self-signed HTTPS certificate; credentials, query parameters, and fragments are rejected. |

### Speech credentials & engine (the `stt` module)
| Var | Meaning |
|-----|---------|
| `YEP_STT_XAI_API_KEY` | xAI key → `ya-grok` backend; auto-enables when set. |
| `XAI_API_KEY` | xAI standard key accepted as a `ya-grok` STT fallback, then scrubbed from child env. Grok Build receives it only when its provider setting explicitly opts in. |
| `YEP_STT_SHARE_XAI_KEY_WITH_CLIENTS` | `1` lets authenticated private clients borrow the configured long-lived xAI STT key for direct browser-to-xAI batch transcription. Default false; direct streaming instead mints short-lived xAI client secrets from `YEP_STT_XAI_API_KEY` and does not require exposing the long-lived key. |
| `YEP_STT_DEEPGRAM_API_KEY` | Deepgram key → `ya-deepgram` backend; auto-enables when set. |
| `WHISPER_MODEL` / `WHISPER_DEVICE` / `WHISPER_COMPUTE_TYPE` | Local Whisper tuning. `ya-whisper` runs through the committed pixi `stt` environment; when explicitly enabled, YA runs `pixi run -e stt stt-bootstrap` if the import probe fails. |
| `PARAKEET_MODEL` / `PARAKEET_DEVICE` | Local NVIDIA Parakeet fallback model and device policy. `ya-parakeet` uses the same pixi `stt` environment with the Transformers Parakeet requirements; when explicitly enabled, YA runs `pixi run -e stt stt-bootstrap-parakeet` if the import probe fails, then loads the fallback model before advertising the backend. Authenticated browser UI may send a per-request Parakeet model id. Defaults: `nvidia/parakeet-tdt-0.6b-v3`, `auto`. |
| `NEMO_MODEL` / `NEMO_DEVICE` | Local NeMo Parakeet fallback model and device policy. `ya-nemo` uses the same pixi `stt` environment plus the heavier NeMo add-on; when explicitly enabled, YA runs `pixi run -e stt stt-bootstrap-nemo` if the import probe fails, then loads the fallback model before advertising the backend. The same browser Parakeet model selector may send a per-request model id. Defaults: `nvidia/parakeet-tdt-0.6b-v3`, `auto`. |

See [pluggable-speech-recognition.md](pluggable-speech-recognition.md) for
backend semantics and [cost-efficiency.md](cost-efficiency.md) for the
metered-vs-free and billing-isolation rules.

### Logging & diagnostics
| Var | Meaning |
|-----|---------|
| `LOG_LEVEL` / `LOG_FILE_LEVEL` | Minimum console / file log level. |
| `LOG_TO_FILE` | `true` enables file logging. |
| `LOG_DIR` / `LOG_FILE` | Log directory / filename overrides. |
| `LOG_PRETTY` | `false` disables pretty console logs. |
| `PROXY_DEBUG` | Enable proxy debug logging at startup. |

### Auth & serving
| Var | Meaning |
|-----|---------|
| `AUTH_DISABLED` | `true` bypasses auth (recovery only). |
| `AUTH_COOKIE_SECRET` | Override auth cookie secret. |
| `SERVE_FRONTEND` | `false` runs API-only (no static client). |
| `MAX_UPLOAD_SIZE_MB` / `MAX_QUEUE_SIZE` | Upload / queue limits. |
| `ALLOWED_IMAGE_PATHS` | Extra dirs allowed for local image serving. |
