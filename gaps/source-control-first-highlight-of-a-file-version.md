# Source Control: first view of a file version still pays whole-file highlighting

`highlightDiffWithSyntax` highlights each side of a diff whole when the two
versions total under `WHOLE_FILE_HIGHLIGHT_MAX_CHARS` (256 KB), for exact
tokenizer context; above that it highlights only an excerpt of the lines the
hunks reference. Tokenizing is ~90µs per line and is paid per side.

Measured 2026-08-02 on a 1936-line Python file with 15 hunks
(`scripts/pii_eval.py`, 249 added / 29 deleted):

| work | cost |
|---|---|
| tokenize one side whole (`codeToTokens`) | ~155 ms |
| `codeToHtml` one side whole (tokenize + HTML) | ~200 ms |
| both sides, excerpt path only | ~50 ms |

The content-keyed highlight cache added with that measurement makes every
repeat view of the same version ~free (whole endpoint 22–55 ms warm). The
first view of a version still pays it: ~350–600 ms with both sides cold, and
~175 ms in the common case where the `HEAD` side is already retained and only
the just-edited working-tree side is new.

Closing the rest means choosing between two things that are currently
bundled, so it wants an explicit decision rather than a constant tweak:

- Lowering the whole-file threshold buys ~6× but accepts the excerpt path's
  known failure mode — a hunk that begins inside a multi-line string or
  comment whose opener falls outside the excerpt tokenizes as code. This is
  already shipped behavior above 256 KB.
- Moving highlighting to a worker pool keeps fidelity, halves the wall clock
  by running the two sides in parallel, and — more importantly — stops a
  ~350 ms synchronous tokenize from blocking the event loop that also
  multiplexes every live agent session.

Splitting HTML generation from tokenization is *not* a way out: the ~45 ms
`codeToHtml` adds over `codeToTokens` is the smaller half.
