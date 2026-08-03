# Storage Settings

> Storage location and tool-result preservation are separate server-wide
> choices. YA uses its configured data directory and makes no persistent copy
> of tool-result images by default; project-local storage and preservation each
> require their own explicit opt-in.

Topic: project-directory-storage

Status: implemented in current source after `0.7.0`. The two permanent
capabilities declare `0.7.1` as their first complete release.

Parent contracts:
[Project Directory Storage](project-directory-storage.md) and
[Session Media Handles](session-media-handles.md).

## Placement And Scope

Settings exposes a first-class **Storage** category immediately after
**Source Control**. A dedicated category is justified even with only two
controls because both are server-wide trust and retention decisions, neither
fits an existing category honestly, and older-server compatibility must remain
visible. **Performance** would misstate filesystem consent as tuning;
**Source Control** would omit attachments and media; **Local Access** and
**Environment** own different server concerns.

The page introduction is conceptually:

> Control where this YA server stores its own project-related data and whether
> it keeps independent copies of new tool-result images. This does not restrict
> files modified by agents or explicit source-control actions.

Both controls are server-persisted and apply to every project and client using
the connected YA server. V1 has no browser-local value, per-project override,
or custom path. `YEP_DATA_DIR` remains the way to choose the YA data directory.

The Settings search index includes the category, both choices, and terms such
as `YEP_DATA_DIR`, project folder, `.yep`, `.attachments`, tool result, image,
preserve, and storage.

## YA-Managed Project Data

The first section presents a radio choice rather than a toggle so the off state
cannot be mistaken for disabling required attachment storage:

### YA data directory — default

Store YA-managed attachments, review state, indexes, and any separately
enabled preserved media below the server's configured YA data directory. Do
not create YA storage paths or YA-owned Git metadata inside projects.

This UI choice maps to:

```ts
settings.projectDirectoryStorage = "app-data";
```

### Inside each project — explicit opt-in

Allow eligible YA-managed state below the single project root
`<project>/.yep/`. YA may best-effort add `.yep/` to that clone's local Git
exclude after containment, symlink, and tracked-path checks.

This UI choice maps to:

```ts
settings.projectDirectoryStorage = "project";
```

New project-local attachment writes use
`<project>/.yep/attachments/<session-id>/`; they do not create or grow a
top-level `.attachments/` directory. Existing `.attachments/` data remains a
read-only compatibility source.

Selecting **Inside each project** chooses a permitted physical location. It
does not enable tool-result preservation, source-review submission history, or
any other independently default-off retention feature.

## Tool-Result Images

The second section presents a separate radio choice. There is no server disk
cache mode in the first implementation: the current persistent blob store has
no eviction behavior, and avoiding a provider-transcript rescan or repeated
base64 decode does not yet justify another setting. A measured future cache is
a separate policy and capability.

### Load on demand — default

Return authenticated lazy media handles without keeping an additional
persistent YA copy. Historical inline media is removed from the session
payload and retained only in a size- and lifetime-bounded process-memory
catalog; the browser fetches the bytes only when the image is viewed. A
path-only result remains available only while its permitted source exists.

This UI choice maps to:

```ts
settings.toolResultMediaPreservation = "on-demand";
```

Loading session details, expanding an image, listing or searching sessions,
starting the server, and listing, adding, opening, or indexing projects create
no persistent tool-result media copy in this mode.

### Preserve new tool-result images — explicit opt-in

Keep independent copies of eligible image results newly emitted while YA is
managing a session. Capture happens at the live tool-result boundary even when
no client tab is open, because a temporary source may disappear before the
next page view.

This UI choice maps to:

```ts
settings.toolResultMediaPreservation = "preserve";
```

The exact timing contract is:

- the setting takes effect for new tool results observed after the update;
- provider replay and persisted history are not new tool results;
- enabling it starts no background scan, import, migration, or backfill;
- loading or paginating historical session details never creates preserved
  copies;
- disabling it stops subsequent captures without deleting existing copies;
  and
- preserved copies are never pruned automatically and may grow without bound.

An implementation must distinguish genuinely new live output from provider
replay when a managed session starts or resumes. If that distinction is not
available at a provider boundary, that provider cannot claim preservation
support by treating replay as new output.

Preservation follows the location choice above:

- **YA data directory:** a project/session namespace below `YEP_DATA_DIR`;
- **Inside each project:**
  `<project>/.yep/tool-results/<session-id>/`.

The UI states the resolved class of destination and warns plainly:

> YA keeps adding preserved tool-result images until preservation is disabled.
> Preserved copies are not removed automatically.

Failure to preserve an optional copy must not interrupt the provider turn,
delete an older copy, or silently place the bytes in another location. The
bounded transient handle remains usable when preservation fails.

## Changes, Mixed Locations, And Legacy Data

Both settings affect future writes only. Changing either setting does not move,
merge, copy, rehash, delete, repair, or add exclusions for existing data. A
server may consequently read a mixture of central data, opted-in `.yep` data,
legacy `.attachments`, and legacy unconditional `.yep/tool-results` data.

Read compatibility is not authorization to refresh or grow a legacy root. The
first implementation includes no migration, merge, historical-media import,
or cleanup workflow. Any later operation with those effects is separate,
explicit product work with its own preview and compatibility contract.

When either stored setting is absent, including after upgrade, it resolves to
its default value: `"app-data"` and `"on-demand"`. Existing files remain in
place and readable where safe.

## Capability Advertisement

The controls are gated independently so later storage features do not broaden
an older advertised promise.

### `project-directory-storage-policy`

This permanent capability owns `GET /api/settings`, `PUT /api/settings`, and
`settings.projectDirectoryStorage: "app-data" | "project"`. Advertisement
attests that the complete audited YA-managed project/Git writer set obeys the
setting and that absent configuration defaults to `"app-data"`.

Without it, the client omits the field and shows the location control as
read-only with an update-required explanation. It does not claim the project
is protected because older stable servers may still write uploads into
`.attachments/`.

### `tool-result-media-preservation-policy`

This permanent capability owns `GET /api/settings`, `PUT /api/settings`, and
`settings.toolResultMediaPreservation: "on-demand" | "preserve"`.
Advertisement attests to all of the following:

- absent configuration defaults to `"on-demand"`;
- on-demand handles make no persistent media copy;
- historical session-detail reads never preserve media;
- preserve mode captures only new results from managed sessions; and
- preserved copies have no automatic expiry, size eviction, or pruning.

Without it, the client omits the field and shows the media control as
read-only with an update-required explanation. An unadvertised current-source
server may contain the earlier unconditional materializer, so the client must
not infer on-demand behavior merely because no stable release shipped that
implementation.

Each capability's registry `introducedIn` value is the first release that
implements its complete invariant. Existing capability meanings remain
unchanged. A later cache, historical import, cleanup, retention limit, custom
location, or per-project override requires a separately reviewed contract and,
when remotely observable, its own exact capability rather than expansion of
either promise above.

## Acceptance

The Settings implementation verifies:

- both defaults on a fresh and upgraded server with absent fields;
- server-wide persistence and immediate application to subsequent writes;
- independent gating, saving, loading, search, and undo behavior;
- read-only missing-capability explanations without unsupported requests;
- no project/Git mutation in app-data mode;
- no durable media write from live or historical sessions in on-demand mode;
- preserve-mode capture for new managed-session results with no open client;
- no preserve-mode capture from replay or historical detail requests;
- destination selection without fallback, movement, merging, or deletion; and
- legacy `.attachments` and `.yep/tool-results` reads without growth.

## Related Topics

- [Project Directory Storage](project-directory-storage.md)
- [Session Media Handles](session-media-handles.md)
- [Attachment Storage](attachment-storage.md)
- [Where settings / UI options live](settings-ui-placement.md)
- [Server Capabilities](server-capabilities.md)
- [Vanilla Defaults](vanilla-defaults.md)
