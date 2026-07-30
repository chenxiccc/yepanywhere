# Multi-Host Remote Access - Implementation Plan

## Overview

Enable storing multiple SRP sessions and switching between hosts (desktop, pi, laptop, etc.) with URL-based routing for relay mode.

## Completed (Phases 1-7)

### Phase 1: Storage Layer
- Added `SAVED_HOSTS_KEY` to `packages/client/src/lib/storageKeys.ts`
- Created `packages/client/src/lib/hostStorage.ts` with:
  - `SavedHost` interface
  - `loadSavedHosts()`, `saveHost()`, `updateHostSession()`, `removeHost()`
  - `getHostByRelayUsername()`, `getHostById()`
  - `createRelayHost()`, `createDirectHost()` helpers

### Phase 2: Host Picker Page
- Created `packages/client/src/pages/HostPickerPage.tsx`
- Shows saved hosts with online/offline status indicators
- Quick connect to saved hosts (session resumption)
- Delete hosts from the list
- "Add Host" section with relay/direct buttons
- Updated `remote-main.tsx` to use `HostPickerPage` at `/login`
- Modified `RelayLoginPage` and `DirectLoginPage` to save hosts after login
- Added CSS styles for host picker

### Phase 3: URL-Based Routing
- Renamed routes: `/relay` → `/login/relay`, `/direct` → `/login/direct`
- Added legacy redirects for old paths
- Created `packages/client/src/pages/RelayHostRoutes.tsx`:
  - Extracts `relayUsername` from URL params
  - Looks up saved host by username
  - Handles auto-connect with session resumption
  - Contains nested routes for all app pages (projects, sessions, etc.)
  - Shows `HostOfflineModal` on connection errors with retry
- Created `packages/client/src/hooks/useRemoteBasePath.ts`:
  - `useRemoteBasePath()` returns `/remote/{username}` base path
  - `useRelayUsername()` extracts username from URL
- Updated `packages/client/src/RemoteApp.tsx`:
  - Added `SELF_MANAGED_ROUTES` for `/remote/*` paths
  - `ConnectionGate` lets self-managed routes handle their own auth
- Updated `packages/client/src/remote-main.tsx`:
  - Added `/remote/:relayUsername/*` route to `RelayHostRoutes`

### Phase 4: Connection Context Updates (Minimal)
- Added `currentHostId` and `setCurrentHostId` to `RemoteConnectionContext`
- Updated `RelayHostRoutes` to call `setCurrentHostId(host.id)` on successful connect
- Note: `connectToHost()`/`connectToRelayUsername()` methods not needed - `RelayHostRoutes` handles connection directly

---

### Phase 5: Link Updates ✓

- All navigation links now include username prefix via `useRemoteBasePath()` hook
- Updated components:
  - `Sidebar.tsx` - passes basePath to all nav items
  - `SidebarNavItem.tsx` - accepts basePath prop, prefixes all links
  - `SessionListItem.tsx` - uses basePath for session links
  - `FloatingActionButton.tsx` - uses basePath for new session/projects
  - `SessionPage.tsx` - uses basePath for breadcrumbs and navigation
  - `ProjectsPage.tsx` - passes basePath to ProjectCard
  - `ProjectCard.tsx` - uses basePath for session links
  - `GlobalSessionsPage.tsx` - passes basePath to SessionListItem
  - `InboxContent.tsx` - uses basePath for inbox items
  - `AgentsNavItem.tsx` - passes basePath to SidebarNavItem
  - `RecentSessionsDropdown.tsx` - uses basePath for session links

---

### Phase 6: Settings "Switch Host" Link ✓

- Updated `packages/client/src/pages/settings/RemoteAccessSettings.tsx`:
  - Added "Current Host" display showing host displayName (from hostStorage) or storedUsername fallback
  - Added "Switch Host" link navigating to `/login` (host picker)
  - Renamed "Connected to" label to "Current Host" for consistency

---

### Phase 7: Session Sync Between Storages ✓

- Updated `packages/client/src/contexts/RemoteConnectionContext.tsx`:
  - Imported `updateHostSession` from hostStorage
  - Added `currentHostIdRef` to track host ID in a ref (so callback always has latest value)
  - Wrapped `setCurrentHostId` to update both state and ref
  - Updated `handleSessionEstablished` to dual-write:
    - Saves to old storage (`updateStoredSession`) for backwards compatibility
    - Also saves to hostStorage (`updateHostSession`) when `currentHostIdRef.current` is set
  - This ensures session refreshes are persisted to both storages during migration

---

### Phase 8: Client Summary Source Isolation (planned)

URL-based host switching and saved-host storage are in place, but the client
summary cache is currently shared across all remote hosts in a browser tab.
Store-backed surfaces such as Sidebar can therefore show sessions from the
previous host while the newly requested host is connecting or loading.

The planned fix is tracked in
[`../tactical/027-client-summary-source-registry.md`](../tactical/027-client-summary-source-registry.md):

- keep the current normalized `ClientSummaryState` shape;
- maintain one Zustand store per backend source (`local`, `host:<id>`, direct
  fallback, or `remote:none`);
- make current-host hooks read only the current source's store;
- require source keys on snapshot/report writers so late responses from one
  host update that host's cache, not the visible current host;
- scope activity-bus reductions and local decorations to the producing source.

This phase should land before more UI surfaces migrate onto the client summary
store.

---

### Phase 9: Experimental Multi-Host Monitor (planned)

The next product proof is a hidden/default-off `/-/monitor` route that mounts
several saved source runtimes at once. It starts on the existing relay
transport, where three hosts deliberately mean three browser-to-relay
WebSockets.

The implementation and E2E sequence is tracked in
[`../tactical/066-multi-host-monitor-coexistence-harness.md`](../tactical/066-multi-host-monitor-coexistence-harness.md).
That runbook requires a real relay, three isolated YA server profiles, genuine
SRP/resume sessions, colliding project/session ids, per-source failure tests,
and direct socket-count observation.

Relay `/mux` is a later, separately reviewed transport series. The existing
multi-host monitor must pass over ordinary independent connections before mux
work starts, and must retain those connections as the fallback when a relay
does not advertise mux support.

---

## Testing Checklist

- [ ] Fresh install: Login page shows empty, can add relay host
- [ ] Add host: After relay login, host appears in saved list
- [ ] Quick connect: Click saved host, auto-resumes if session valid
- [ ] Session expired: Redirects to login form pre-filled
- [ ] Delete host: Removes from list
- [ ] URL routing: `/remote/desktop/projects` connects to "desktop"
- [ ] Multi-tab: Two tabs open to different hosts work independently
- [ ] Same-tab switch: Navigating from one saved relay host to another does
      not show sessions, inbox counts, or queue badges from the previous host
- [ ] Bookmarks: Saved URL auto-connects to correct host
- [ ] Switch host: Settings link goes to host picker
- [ ] Status indicators: Shows online/offline for relay hosts
- [ ] Multi-host monitor: Three relay hosts coexist with isolated summary data
- [ ] Partial failure: One offline or unauthenticated host leaves the others live
- [ ] Route teardown: Leaving the monitor releases every acquired source lease
- [ ] Transport baseline: Three selected hosts use three observed relay sockets

---

## Migration Notes

- No migration needed for existing users - they just re-login
- Old `REMOTE_CREDENTIALS_KEY` storage continues to work during transition
- New `SAVED_HOSTS_KEY` storage is additive
- Eventually can deprecate old storage in future release
