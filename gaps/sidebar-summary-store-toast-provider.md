# Sidebar summary-store tests omit the toast provider

`packages/client/src/components/__tests__/SidebarSummaryStore.test.tsx` renders
`Sidebar` without the `ToastProvider` now required by `useToastContext`. Both
tests fail before reaching their summary-store assertions.

The isolated reproducer is:

```bash
pnpm --filter @yep-anywhere/client exec vitest run \
  src/components/__tests__/SidebarSummaryStore.test.tsx
```

The likely fix is to wrap this test's render helper in the same provider stack
used by the passing Sidebar suites. This was not fixed in place because the
failure is unrelated to the active-turn sharing and file-link work.

Found 2026-08-10 while running the full client suite for active-turn sharing
and project-path diff links.
