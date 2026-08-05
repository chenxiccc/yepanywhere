# `pnpm lint` fails: committed `index.css` exceeds its frozen line limit

`node scripts/check-css-architecture.mjs` (the first step of `pnpm lint`)
fails on a clean tree:

```
css-architecture: packages/client/src/styles/index.css: 16295 lines exceeds the frozen limit of 16267
```

`scripts/css-architecture-baseline.json:8` records `maxLines: 16267`, last
touched by `fe316c3e`. Two later commits grew the frozen sheet without
extracting to a CSS Module or ratcheting the baseline: `aca53cfd` (+21) and
`913232cf` (+7), which is exactly the 28-line overshoot.

Not fixed in place because the resolution is a judgment call the freeze exists
to force, and neither commit is mine: either extract those 28 lines into the
owning components' CSS Modules (what the checker's own message asks for), or
accept them with `--record`, which lowers/raises limits to current counts and
would silently bless the growth.

Found 2026-08-05 while adding the conversation activity row's height reserve,
whose rule went to `RenderItemComponent.module.css` rather than the frozen
sheet for this reason.
