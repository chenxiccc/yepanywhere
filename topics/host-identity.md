# Host Identity Marker

> A server-owned optional emoji marker distinguishes YA hosts in connected app
> headers and browser tabs without changing the default interface.

Topic: host-identity

## Contract

- Host identity is server-owned configuration. YA does not store a client-only
  fallback or attempt to write the setting to servers that do not advertise
  support.
- Supporting servers advertise the permanent `host-identity` capability and
  persist an optional `hostIdentity.icon` setting. Clients hide the setting and
  render no marker when the capability is absent.
- The icon is default-off. An unset or cleared icon leaves the existing header
  and browser-tab presentation unchanged.
- The Remote Access settings pane exposes a compact curated emoji palette plus
  a custom entry. A saved custom entry must contain exactly one user-perceived
  grapheme and remain within the server's bounded storage limit.
- When configured, the marker appears immediately after the leading
  sidebar/back control and before the current page or session title. It remains
  visible when the leading control is absent.
- The configured marker also prefixes the base browser-tab title. Existing
  attention-count and activity prefixes remain ahead of it, so a title may read
  `(3) (●) 💻 project - session`.
- The marker is decorative only: activating it does not disconnect, switch
  hosts, or open a new interaction surface. Its accessible label identifies it
  as the current host marker.
- Disconnected host-picker rows do not display the marker. Supporting that
  would require client caching or unauthenticated host metadata, both outside
  this feature's server-owned scope.
- A connected native multi-host client may use the marker on source filters,
  aggregate session/activity cards, and server settings rows. The username
  remains the fallback and the source boundary remains visible. A cold offline
  row still does not invent or persist a client-owned marker.

## Compatibility

- New client + supporting server: the setting is editable and the saved marker
  is rendered.
- New client + older server: the missing capability hides both the setting and
  marker; no fallback persistence or probing write occurs.
- Older client + supporting server: older clients ignore the additional
  settings response field and their partial settings updates do not clear it.
- This optional feature does not raise `remoteCompatibilityLevel` or alter any
  transport protocol.

## Related Topics

- [vanilla-defaults](vanilla-defaults.md) — novel UI chrome remains opt-in.
- [server-capabilities](server-capabilities.md) — capability registry and
  older-server gating policy.
- [remote-hosted-compatibility](remote-hosted-compatibility.md) — why one
  narrow capability does not raise the coarse compatibility level.
