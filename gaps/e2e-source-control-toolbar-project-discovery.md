# Source Control toolbar E2E fixture is not discoverable

`packages/client/e2e/source-control-toolbar-layout.spec.ts` creates its Git
project in `beforeAll`, after the isolated server has assembled its project
inventory. The direct Source Control URL therefore renders `Error: Project not
found`; `.git-diff-pane-toolbar` never mounts, and the focused spec fails
consistently as well as in the full Playwright run.

This is outside the filesystem-delivery change being verified. Move creation of
the project and its Claude session record into global setup, or explicitly make
the late-created project discoverable through the supported project-inventory
path before navigating.

Found 2026-08-20 while verifying complete filesystem worktree delivery.
