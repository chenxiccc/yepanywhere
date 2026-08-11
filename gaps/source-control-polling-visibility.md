# Source Control polling may continue without useful visibility

`packages/client/src/hooks/useGitStatus.ts` refreshes a selected project's
full local Git status every five seconds whenever the hook is mounted and
`document.visibilityState` is `visible`. `GitStatusPage` is the only polling
caller in current source, and unmount cleanup removes its interval, but this
lifecycle needs a browser-level proof across route changes, retained page
state, multiple browser tabs, minimized windows, and restored tabs.

The five-second cadence also needs justification against its repository cost.
Investigate whether repository or YA activity can invalidate status on demand,
with a slower safety refresh or an explicit refresh as fallback. At minimum,
prove that polling runs only while Source Control is the selected route and
stops in a background browser tab. Browsers do not generally expose true
pixel-level occlusion, so record which offscreen cases `visibilityState` can
and cannot gate rather than treating `visible` as proof that the user can see
the page.

The motivating incident reproduced transient `.git/index.lock` contention
from YA's status endpoint. The user recalls that a Source Control view remained
open in the browser, but was not onscreen, throughout the observed lock
interference. Optional-lock suppression fixes that contention independently;
the observation is evidence that the poller's effective visibility lifecycle
still needs verification.

Found 2026-08-11 while fixing Source Control status-poll index locking.
