# Source review follow-ups

> Source review follow-ups are optional agent-authored annotations for later
> clarification, discussion, source-comment, or gap sweeps, kept separate from
> per-comment outcomes and requested only when YA has an intended consumer and
> action path.

Topic: source-review-followups

Parent topic: [Source Review → New Session](source-review-to-session.md).

Status: **proposal only**. YA does not prompt for, persist, render, or act on
these annotations.

## Product boundary

The immediate outcome answers what happened to the submitted review comment:
**Done**, **No change**, or **Question**. A follow-up annotation instead says
that the response exposed material worth carrying somewhere else. The two axes
must compose: a completed change can expose a gap, and a no-change response can
still identify a useful clarification or source comment.

The provisional human-facing tags are:

- **Clarification** — explanatory material or a premise should be made more
  explicit without blocking the current review outcome.
- **Discussion** — a design or policy question deserves a durable conversation
  outside the line-level review.
- **Add source comment** — a local invariant or non-obvious reason may belong
  beside the source it governs.
- **Gap** — concrete project debt should be considered for the project's gap
  tracker.

These labels bank the product direction, not a response schema. Before
versioning them, decide from real examples whether the annotation needs
separate intent and destination fields rather than one flat tag.

## Activation condition

Do not add follow-up annotations to the source-review prompt merely because an
agent could produce them. Activate the channel only when YA intends to receive
and act on it:

- the response format can carry bounded annotation text and any required
  source/site reference without weakening complete-snapshot validation;
- Reviews exposes the suggestions and lets the reviewer accept, edit, or
  discard each one;
- the post-review sweep can preview and optionally batch the chosen actions;
  and
- compatibility and migration behavior are explicit for responses written by
  newer and older YA versions.

No annotation directly edits a topic, creates a gap, or changes source. A
sweep proposes those materializations, and the reviewer remains the decision
boundary.

## Sweep direction

The likely destinations are existing project surfaces: durable clarifications
and discussions into the owning `topics/*.md`, accepted debt into `gaps/*.md`,
and local invariants into source comments. The destination is a suggestion,
not a mechanical mapping: discussion can conclude with no artifact, and an
apparent source-comment need may instead reveal a naming or structure problem
that should be fixed in code.
