# Rich Interviews

> Banked proposal (postponed indefinitely): rich structured-input interviews —
> comment/select/confirm controls over forms, text, and media, possibly
> spanning multiple adaptive rounds — issued and consumed by user-configured
> workflows/skills, with YA's role limited to understanding the interchange
> formats well enough to render each round's input form and its produced
> results inline in a session.

Topic: rich-interviews

Status: **banked, postponed indefinitely (2026-07-24).** Nothing implemented;
no format chosen; even the research survey below is deliberately on ice.
Rationale for banking: less incremental value than the [[interactives]]
container, and not enough to justify design attention while that work is
live; the expectation is that machinery the container accumulates — app
template, meta-UI channel, inline embedding — may later make these use cases
easily buildable, at which point the research-first plan below is the resume
point. Split out of [[interactives]], where an earlier draft coupled this
flow to the web-app container; the two share an embed seam only (below).

## Intent

Routine use, not ad-hoc fun: advanced interview-type flows — e.g. reviewing a
UI tweak by annotating screenshots, structured design tradeoff elicitation —
richer than plain option prompts. The value materializes only when a user
correctly sets up workflows/skills that both *issue* interviews and *consume*
their results; without that loop the feature is dead UI. The issuing and
consuming conventions are therefore part of the proposal, not an afterthought.

## Shape: multiturn, not one-shot

An interview is an exchange, not a single form: issue a round → user answers →
the issuer may generate further rounds from those answers → explicit close.
This is intentionally far more general than the Claude-harness batched
question bundle (AskUserQuestion-style: one bundle of a few questions, closed
after one answer set), which is the degenerate single-round case. Keep two
kinds of branching distinct in the design and the format survey:

- **In-form branching** — declarative skip/branch logic inside one round;
  form-local, no issuer involvement, expressible in existing form formats.
- **Issuer-adaptive rounds** — the next round's questions are computed by the
  issuing agent/workflow from previous answers; a conversational protocol
  whose turns happen to be structured forms.

## YA's narrow role

Format understanding only: render a declared round's input form inline in the
session, capture the user's answers, and render the produced result inline.
YA is not an interview builder, serves no html+js bundles for this, and takes
on no sandbox obligations here. Result landing is a candidate, not committed:
a per-round result document written as a project-local attachment
([[attachment-storage]]) plus a turn referencing it, reusing the existing
uploaded-files prompt listing.

## Research first

Before designing any format, survey others' best practices and adapt rather
than invent. Candidate anchors (unvetted, to be assessed by the survey):
JSON-schema-driven form renderers (JSON Forms, react-jsonschema-form,
SurveyJS — the latter two carry in-form branching), annotation interchange
(W3C Web Annotation data model, Label Studio's labeling JSON), and
field-survey flow systems (ODK/XForms) for multi-round structure. The survey
should also look for prior art on issuer-adaptive protocols, which most form
standards do not cover.

## Precedent in YA

Turn-scoped ask→answer surfaces already exist: AskUserQuestion-style option
prompts, permission approvals, and [[selection-comment-ui]] (comment anchors,
quote-comment). Rich interviews generalize these; they should feel like a
richer member of the same family, not a separate app.

## Non-goals (now)

- No served bundles, upload routes, or sandboxing — if an interview ever
  needs arbitrary DOM expressiveness, it embeds an [[interactives]] entry;
  that directional reference is the only implementation seam between the two
  proposals, and that entry must satisfy [[active-content-security]] rather
  than execute inside the YA document. (Intent-adjacent but separate: the
  interactives *meta-UI
  protocol* carries freeform in-app comments to the agent; rich interviews
  are the structured, multi-round counterpart.)
- No YA-side interview authoring UI.

## Open decisions

- Interchange format choice (post-survey) and its versioning.
- Round/close protocol for issuer-adaptive interviews (how a round's answers
  reach the issuer, how the next round is issued, what marks the interview
  closed).
- Issuing convention (how a workflow/skill emits an interview into a session)
  and consuming convention (how results are reliably parsed).
- Result landing (attachment + referencing turn vs something else).

## See also

- [[interactives]] — the split-off app container and the embed seam.
- [[active-content-security]] — declarative YA-owned forms remain fragments;
  arbitrary executable DOM requires an isolated untrusted-content origin.
- [[selection-comment-ui]] — nearest shipped precedent for select/comment.
- [[attachment-storage]] — candidate result landing.
- [[vanilla-defaults]] — any interview UI ships self-gated/off by default.
