# Common-word basenames can create unintended file links

The prefix-causal basename replay in
`packages/client/src/lib/recentProjectPathLinks.ts` supports extensionless
files, so an ordinary word equal to a recently established basename can be
linked when the assistant did not mean the file. This is an accepted initial
tradeoff pending evidence of real user frustration.

If the false positives become disruptive, measure examples before choosing a
fix. A small dictionary of common word-like filenames is one candidate, but it
would also suppress intentional references and should not be added
speculatively.

Found 2026-08-30 while adding recent project-path basename aliases.
