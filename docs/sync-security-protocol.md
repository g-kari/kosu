# Sync protocol 2

Clients must send `protocol=2` on pull and `{ protocol: 2, scope_token }` on push. Older clients receive an explicit error and must upgrade; they must not interpret this as an empty successful sync.

The pull scope digest binds the account, memberships, tenant hierarchy and latest deletion. A changed digest returns `reset: true` with no entity payload. The client clears that tenant's mirror, starts at cursor zero and replays only currently authorized entities. The server rechecks the digest before returning a page. Deleted parent scopes are inaccessible for both push and pull. A purge invalidates the digest even though its tombstone no longer has an entity available for authorization.

`SyncEngine.push` first refreshes access. After an access reset, unsent edits are preserved in local `sync_quarantine` rather than silently uploaded or discarded. `quarantinedChanges()` exposes only the currently verified owner's records for explicit recovery by the host application. These records are not automatically resubmitted. The host must provide an account-specific database and a recovery/export interface before using this local-first component in production. Existing unowned local edits require manual recovery. Account changes fail closed before uploading queued plaintext.

Offline edits use the last verified account; no implementation can retract data already read while authorized from a disconnected device. A network identity failure prevents upload. On an online access denial, the affected tenant mirror and local conflict cache are cleared and queued edits are preserved in quarantine. A successful pull does not prove that a later request remains authorized; server-side write authorization is always enforced independently.

This is a compatibility change. Deploy the matching client and API together. Migration 0009 is required to record scope reassignments atomically for all writers; apply it before deploying this API. No production migration or deployment is performed here. The local sync module is not currently wired into the app UI, so recovery UI integration remains an explicit acceptance requirement rather than a claimed deployed feature.
