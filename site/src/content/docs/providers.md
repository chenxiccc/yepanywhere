---
title: Providers
description: Understand the primary Claude Code and Codex integrations and the narrower experimental provider options.
---

Yep Anywhere detects installed agent providers and presents them through one
session interface. Provider support is not binary: each upstream exposes
different control, history, approval, and model primitives.

## Primary providers

| Provider | Status | Expected workflow |
| --- | --- | --- |
| Claude Code | Stable | Sessions, streaming, approvals, diffs, steering, recaps, model and permission controls |
| Codex | Stable | Sessions, streaming, approvals, apply-patch diffs, steering, recaps, model and effort controls |

Authenticate with each provider's official CLI. Yep Anywhere uses the official
provider harness or protocol and does not intercept OAuth tokens.

## Experimental providers

| Provider | Current shape |
| --- | --- |
| OpenCode | Start/resume, history, permissions/questions, tools, thinking, and images; capability parity varies |
| Grok Build | ACP-based sessions with approvals, suggestions, effort, and steering where upstream supports them |
| Claude + Ollama | Local Ollama models through a Claude-compatible path; requires Ollama 0.14+ |
| Gemini CLI | Direct and experimental ACP paths with narrower approval, steering, and history behavior |
| pi | Headless RPC sessions with streaming, tool rendering, model/thinking controls, compaction, forks, and durable history; tools currently run without a Yep Anywhere approval bridge |

Experimental means the integration ships and can be used, but it may require
extra setup, expose fewer controls, or change as its upstream protocol evolves.

## Session interoperability

Compatible Claude Code and Codex sessions started in a terminal, VS Code, or a
first-party desktop application appear in Yep Anywhere history. You can inspect
them and resume supported sessions without importing them into a new database.

Yep Anywhere URLs retain a stable YA session id. Provider-native resume handles
remain an implementation detail unless a provider contract explicitly exposes
a mapping.

## Models and effort

Model and thinking controls appear only when the provider reports support.
Changing model or effort does not imply that every provider applies the change
at the same lifecycle point. If a control is absent, check the provider status
and server version before assuming detection failed.

## Limit provider visibility

An operator can restrict exposed providers:

```bash
ENABLED_PROVIDERS=claude,codex yepanywhere
```

This is useful for shared or focused installations. It does not install,
authenticate, or remove provider software.
