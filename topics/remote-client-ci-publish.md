# Remote Client CI Publish (proposal)

> Proposal for an opt-in GitHub Actions workflow that builds the hosted
> remote client and publishes it to a personal GitHub Pages repo on every
> push, gated entirely on repository variables so it is inert on any repo
> (including upstream) that does not configure it.

Topic: remote-client-ci-publish

Status: proposal only (2026-07-02); not implemented. The graehl
deployment stays with the local build-and-push flow for now. Recorded
because the design is sound and may be worth adopting later or offering
upstream as a self-hoster feature.

See also: `topics/trusted-client-packaging.md` (serving trust model).
The maintainer's fork-CI-before-upstream gating notes are checkout-local
(a `topics/*.local.md` file), not committed policy.

## Motivation

A personal deployment of the hosted remote client (e.g. `ya.graehl.org`)
is built from this repo (`vite.config.remote.ts`) and served from a
separate GitHub Pages repo. The local publish flow builds with
`VITE_DEFAULT_RELAY_URL` set and pushes the built assets. Two failure
classes motivate automating it:

- Forgetting the build-time env var: the bundle then defaults to the
  public relay (`DEFAULT_RELAY_URL` in
  `packages/shared/src/relay-url.ts`), and a fresh login that leaves the
  relay field blank used to silently rewrite the saved host onto a relay
  the personal server never registers with, failing later with
  `server_offline` (diagnosed 2026-07-02; the login-side mitigation is
  `resolveLoginRelayUrl`, which keeps a saved host's relay when the form
  field is blank).
- A deployment policy of "every user-facing push implies a hosted-client
  publish" otherwise relies on the operator remembering a second manual
  step.

## Design

One workflow (e.g. `.github/workflows/publish-remote-client.yml`) on the
default branch:

- Triggers: `push` to `main`, plus `workflow_dispatch` for manual
  re-publish.
- Gate: job-level `if: vars.REMOTE_CLIENT_PAGES_REPO != ''`. Repository
  variables are per-repo settings, so the job skips everywhere until a
  deployment sets:
  - `REMOTE_CLIENT_PAGES_REPO` — target Pages repo (`owner/name`);
    doubles as the enable switch.
  - `REMOTE_CLIENT_RELAY_URL` — value for `VITE_DEFAULT_RELAY_URL`.
  - `REMOTE_CLIENT_PAGES_BRANCH` — optional, default `master`.
  - Secret `REMOTE_CLIENT_PAGES_DEPLOY_KEY` — write deploy key for the
    Pages repo.
- Steps: pnpm setup (same idiom as `ci.yml`); build shared + client
  (`tsc`, then `vite build --config vite.config.remote.ts --base /` with
  the relay var); fail unless the built bundle contains the baked relay
  host; check out the Pages repo with the deploy key; `rsync -a`
  excluding `.git`, `CNAME`, `.nojekyll`, `manifest.json`, and without
  `--delete` (Pages/browser caches can serve old HTML while new hashed
  assets are live, so prior assets must survive at least one deploy);
  copy `remote.html` to `index.html`, `404.html`, `login/index.html`,
  `login/direct/index.html`, `login/relay/index.html`; commit naming the
  source SHA, skipping when the sync produced no diff; push. GitHub's
  built-in branch deploy then serves it — the Pages repo stays in plain
  "deploy from a branch" mode.
- Optional pre-publish gate: the client Playwright relay integration
  suite (`e2e/relay-integration.spec.ts`); it is self-contained
  (isolated relay + YA server + remote client).
- A `concurrency` group with `cancel-in-progress` so rapid pushes do not
  queue stale publishes.

## Costs / why not adopted yet

- Unconfigured repos still record a skipped run per push in their
  Actions tab — inert but visible. This is the floor for on-push
  automation: push-triggered workflows run from the workflow file in the
  pushed ref, so the file must live on `main` and rides it upstream.
- CI-built bytes replace locally built and verified bytes; see
  `topics/trusted-client-packaging.md` for why the serving trust model
  matters. The optional e2e gate narrows but does not close this.
- It removes none of the GitHub Pages serve-side ceremony (deployment
  queue plus roughly ten minutes of edge cache). A 2026-07-02 GitHub
  incident left a branch-push deploy queued and erroring for over half
  an hour; a CI publish lands in the same queue.
