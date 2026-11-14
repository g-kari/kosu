-- Kosu phase 2: tasks/time tracking core, local-first sync, Gantt support,
-- tenant settings (work calendar + rounding), invites, account vault keys.
--
-- Sync model (see docs/DESIGN.md 同期アーキテクチャ): every mutation of a
-- syncable entity (task, time_entry, task_dependency, milestone) appends a
-- row to sync_changes with a per-tenant monotonic seq. Entities carry an
-- optimistic-concurrency `version`; a sync push whose base_version does not
-- match loses to the server copy and is recorded in sync_conflicts.

-- ---------------------------------------------------------------------------
-- Extensions to the phase-1 tables.
-- ---------------------------------------------------------------------------

ALTER TABLE tasks ADD COLUMN estimate_minutes INTEGER;
ALTER TABLE tasks ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE tasks ADD COLUMN deleted_at TEXT;

ALTER TABLE time_entries ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE time_entries ADD COLUMN deleted_at TEXT;
-- Set when a single entry runs longer than the long-running threshold
-- (12h); running entries are also flagged dynamically by the API.
ALTER TABLE time_entries ADD COLUMN long_running INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_tasks_deleted ON tasks(project_id, deleted_at);
CREATE INDEX idx_time_entries_deleted ON time_entries(task_id, deleted_at);
CREATE INDEX idx_time_entries_tenant_account
  ON time_entries(tenant_id, account_id, started_at);

-- ---------------------------------------------------------------------------
-- Gantt: dependencies between tasks and project milestones.
-- ---------------------------------------------------------------------------

CREATE TABLE task_dependencies (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE UNIQUE INDEX idx_task_deps_pair
  ON task_dependencies(task_id, depends_on_task_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_task_deps_project ON task_dependencies(project_id);
CREATE INDEX idx_task_deps_task ON task_dependencies(task_id);

CREATE TABLE milestones (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  date TEXT NOT NULL, -- YYYY-MM-DD
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_milestones_project ON milestones(project_id);

-- ---------------------------------------------------------------------------
-- Local-first sync: change log, conflicts, devices.
-- ---------------------------------------------------------------------------

CREATE TABLE sync_counters (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  last_seq INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE sync_changes (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  entity_type TEXT NOT NULL, -- task | time_entry | task_dependency | milestone
  entity_id TEXT NOT NULL,
  op TEXT NOT NULL, -- upsert | delete
  payload TEXT, -- JSON of the entity after the change (ciphertext stays ciphertext)
  account_id TEXT,
  device_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, seq)
);
CREATE INDEX idx_sync_changes_entity
  ON sync_changes(tenant_id, entity_type, entity_id);

-- A push that lost the version race. Resolution policy (phase 2): the
-- server copy wins; both payloads are kept here for the phase-3 diff UI.
CREATE TABLE sync_conflicts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  server_version INTEGER NOT NULL,
  client_base_version INTEGER NOT NULL,
  server_payload TEXT,
  client_payload TEXT,
  account_id TEXT,
  device_id TEXT,
  status TEXT NOT NULL DEFAULT 'open', -- open | resolved
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX idx_sync_conflicts_tenant ON sync_conflicts(tenant_id, status);

CREATE TABLE sync_devices (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  platform TEXT,
  created_at TEXT NOT NULL,
  last_seen_at TEXT,
  revoked_at TEXT
);
CREATE INDEX idx_sync_devices_account ON sync_devices(account_id);

-- ---------------------------------------------------------------------------
-- Account encryption vault. The account data key (ADK) is generated on the
-- client and wrapped with a key derived from the recovery code (PBKDF2).
-- The server stores only the wrapped key and the recovery code's hash; it
-- never sees the ADK or the recovery code in plaintext.
-- ---------------------------------------------------------------------------

CREATE TABLE account_keys (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  wrapped_key TEXT NOT NULL,
  kdf_salt TEXT NOT NULL,
  kdf_iterations INTEGER NOT NULL,
  recovery_code_hash TEXT NOT NULL, -- SHA-256 hex of the normalized code
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Tenant settings: work calendar and time rounding.
-- ---------------------------------------------------------------------------

CREATE TABLE tenant_settings (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  -- JSON array of ISO weekday numbers (1 = Monday .. 7 = Sunday).
  weekly_workdays TEXT NOT NULL DEFAULT '[1,2,3,4,5]',
  rounding_minutes INTEGER NOT NULL DEFAULT 15,
  rounding_mode TEXT NOT NULL DEFAULT 'nearest', -- nearest | up | down
  updated_at TEXT NOT NULL
);

CREATE TABLE workspace_settings (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  rounding_minutes INTEGER, -- NULL = inherit the tenant setting
  rounding_mode TEXT,       -- NULL = inherit the tenant setting
  updated_at TEXT NOT NULL
);

-- Per-date overrides on top of the weekly pattern.
CREATE TABLE tenant_calendar_days (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  date TEXT NOT NULL, -- YYYY-MM-DD
  kind TEXT NOT NULL, -- holiday | workday
  note TEXT,
  PRIMARY KEY (tenant_id, date)
);

-- ---------------------------------------------------------------------------
-- Invites. No mail infrastructure exists, so an invite is a token link the
-- inviter shares out of band; only the token hash is stored.
-- ---------------------------------------------------------------------------

CREATE TABLE invites (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  level TEXT NOT NULL, -- tenant | workspace | team | project
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  team_id TEXT REFERENCES teams(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_by_account_id TEXT NOT NULL REFERENCES accounts(id),
  expires_at TEXT NOT NULL,
  accepted_by_account_id TEXT REFERENCES accounts(id),
  accepted_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_invites_tenant ON invites(tenant_id);
