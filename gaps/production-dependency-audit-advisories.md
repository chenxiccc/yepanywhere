# Production dependency audit reports three ignored advisories

`pnpm audit --prod` currently reports three ignored advisories outside the
Markdown renderer dependency change:

- high, `react-router@7.18.0`, GHSA-qwww-vcr4-c8h2. The affected behavior is
  React Server Components action handling; YA uses client-side
  `BrowserRouter`, not RSC mode.
- moderate, `@hono/node-server@1.19.14`, GHSA-frvp-7c67-39w9. The affected
  helper is Windows `serve-static` path handling; YA does not import that
  helper, although the vulnerable package version remains in the graph.
- moderate, transitive `uuid@9.0.1`, GHSA-w5hq-g745-h8pq. The affected API is
  caller-provided buffers for name-based UUID generation; YA does not call the
  transitive package directly.
These are not reachable through the Markdown renderer configuration and should
not be folded into its parser migration. Re-audit the exact consuming paths,
then update the direct or parent dependencies (or add a narrowly justified
override) with their own compatibility tests. Root `package.json`
`pnpm.auditConfig.ignoreGhsas` and `CLAUDE.md` **Known-unreachable advisories**
carry the current justification and revisit triggers. The former `body-parser`
advisory is no longer present; the separate direct `sanitize-html` finding was
patched in place because that dependency owns the renderer's output boundary.

Found 2026-08-02 while replacing Marked with markdown-it and auditing the
production renderer dependency graph.
