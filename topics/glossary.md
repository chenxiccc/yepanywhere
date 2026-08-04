# Glossary

> The project glossary is the root `GLOSSARY.md` vocabulary table whose
> topic-linked rows summarize cross-cutting topic docs and whose vernacular
> rows preserve Yep Anywhere naming decisions.

Topic: glossary

## Contracts

- `GLOSSARY.md` lives at repo root and contains one sorted table with columns
  `| term | definition | topic / refs |`.
- Topic-linked rows correspond to non-companion `topics/<name>.md` files.
  Their definitions should come from the topic doc's blockquote lede when the
  topic has one.
- Every term surface is bold Markdown. A topic-linked term starts with its
  topic basename, and each deliberately supported shorter or prose form follows
  as a separately bold, comma-separated alternative. Comma-separated forms are
  independent glossary matches.
- A hyphen-minus inside bold term text automatically contributes a second
  surface with every bold hyphen-minus replaced by a space. Hyphens outside
  bold text remain literal.
- Vernacular rows are curated. Add one only when a term's Yep Anywhere meaning
  is distinct from default usage.
- The glossary is a lookup surface, not a contribution manual; regeneration
  and editing rules live in this topic doc.

## Regeneration

Scan `topics/*.md` from repo root, excluding companion files such as
`*.evidence.md`. For each topic doc with an H1 followed by a `> ` blockquote
lede, use the space-joined lede as the glossary definition and link the row as
`[<name>](topics/<name>.md)`. Write the term as `**<name>**`.

When a topic doc lacks a lede, either keep a concise curated row in
`GLOSSARY.md` or normalize the topic doc by adding a body-preserving lede from
its first paragraph. Do the full normalization pass separately when it would
make the glossary materially more accurate.

Vernacular rows without a topic link are preserved by hand. If a term is a
tentative resolution of user wording, mark it with
`<!-- unconfirmed: YYYY-mm-dd -->` until confirmed or removed.

## Adding Terms

Before introducing a new symbol name, UI label, doc heading, or commit topic,
check the nearest relevant `GLOSSARY.md`. Reuse a glossary term when it already
carries the concept.

If a new distinction is genuinely project-specific, add a row here at the
narrowest enclosing glossary scope. The root glossary is the terminal scope for
terms used across the whole repo.
