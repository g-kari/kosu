-- Kosu phase 1: four-level hierarchy (tenant -> workspace -> team -> project)
-- with per-level membership roles, API keys and OIDC login state.
--
-- 0001 created a workspace-first schema (workspaces / members / projects plus
-- the phase-2 tables tasks / time_entries / links / linear_sync / github_sync /
-- audit_log hanging off it). The hierarchy redesign supersedes that layout, so
-- the overlapping tables are replaced here. The old tables hold no data yet
-- (the scaffold shipped no write paths), and the dependent phase-2 tables are
-- recreated with the same columns plus tenant ancestry so later phases keep a
-- coherent schema. accounts from 0001 is kept unchanged: OIDC `sub` values
-- live only in accounts.oidc_sub and are never exposed.

-- Drop children before parents so FK actions stay quiet on the empty tables.
DROP TABLE IF EXISTS links;
DROP TABLE IF EXISTS time_entries;
DROP TABLE IF EXISTS tasks;
DROP TABLE IF EXISTS linear_sync;
DROP TABLE IF EXISTS github_sync;
DROP TABLE IF EXISTS audit_log;
DROP TABLE IF EXISTS projects;
DROP TABLE IF EXISTS members;
DROP TABLE IF EXISTS workspaces;

-- ---------------------------------------------------------------------------
-- Hierarchy levels. Soft delete via deleted_at on every level.
-- ---------------------------------------------------------------------------

CREATE TABLE tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'team', -- personal | team
  created_by_account_id TEXT NOT NULL REFERENCES accounts(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE tenant_members (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member', -- owner | admin | member
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, account_id)
);
CREATE INDEX idx_tenant_members_account ON tenant_members(account_id);

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_by_account_id TEXT NOT NULL REFERENCES accounts(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_workspaces_tenant ON workspaces(tenant_id);

CREATE TABLE workspace_members (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member', -- admin | member
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, account_id)
);
CREATE INDEX idx_workspace_members_account ON workspace_members(account_id);

CREATE TABLE teams (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_by_account_id TEXT NOT NULL REFERENCES accounts(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_teams_workspace ON teams(workspace_id);
CREATE INDEX idx_teams_tenant ON teams(tenant_id);

CREATE TABLE team_members (
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member', -- lead | member
  created_at TEXT NOT NULL,
  PRIMARY KEY (team_id, account_id)
);
CREATE INDEX idx_team_members_account ON team_members(account_id);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description_enc TEXT,
  color TEXT,
  starts_on TEXT, -- YYYY-MM-DD
  due_on TEXT,    -- YYYY-MM-DD
  created_by_account_id TEXT NOT NULL REFERENCES accounts(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_projects_team ON projects(team_id);
CREATE INDEX idx_projects_workspace ON projects(workspace_id);
CREATE INDEX idx_projects_tenant ON projects(tenant_id);

CREATE TABLE project_members (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'viewer', -- admin | editor | viewer
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, account_id)
);
CREATE INDEX idx_project_members_account ON project_members(account_id);

-- ---------------------------------------------------------------------------
-- Phase-2 tables recreated with tenant ancestry (columns otherwise as 0001).
-- ---------------------------------------------------------------------------

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  team_id TEXT REFERENCES teams(id) ON DELETE SET NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  parent_task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description_enc TEXT,
  status TEXT NOT NULL DEFAULT 'todo', -- todo | doing | done (extensible)
  assignee_account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  start_date TEXT, -- YYYY-MM-DD, Gantt start
  due_date TEXT,   -- YYYY-MM-DD, Gantt end / deadline
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_tasks_tenant ON tasks(tenant_id);
CREATE INDEX idx_tasks_workspace ON tasks(workspace_id);
CREATE INDEX idx_tasks_project ON tasks(project_id);
CREATE INDEX idx_tasks_parent ON tasks(parent_task_id);

CREATE TABLE time_entries (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  started_at TEXT NOT NULL,
  ended_at TEXT,          -- NULL while the timer is running
  duration_seconds INTEGER, -- set for manual entries / stopped timers
  note_enc TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_time_entries_task ON time_entries(task_id);
CREATE INDEX idx_time_entries_account ON time_entries(account_id, started_at);

CREATE TABLE links (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, -- slack | linear | github_commit | github_pr | github_issue | url
  url TEXT NOT NULL,
  external_id TEXT,
  title_cache TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_links_task ON links(task_id);
CREATE UNIQUE INDEX idx_links_external ON links(kind, external_id)
  WHERE external_id IS NOT NULL;

CREATE TABLE linear_sync (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  team_id TEXT,
  project_ext_id TEXT,
  api_token_enc TEXT,
  last_synced_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_linear_sync_workspace ON linear_sync(workspace_id);

CREATE TABLE github_sync (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  repo_full_name TEXT NOT NULL, -- owner/repo
  api_token_enc TEXT,
  last_synced_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_github_sync_workspace ON github_sync(workspace_id);

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  tenant_id TEXT REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  detail TEXT, -- non-secret summary only; never plaintext of *_enc fields
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_audit_tenant ON audit_log(tenant_id, created_at);
CREATE INDEX idx_audit_workspace ON audit_log(workspace_id, created_at);

-- ---------------------------------------------------------------------------
-- Auth support tables.
-- ---------------------------------------------------------------------------

-- Per-account API keys, bound to one tenant. Only the SHA-256 hash of the
-- token is stored; scopes is a space-separated subset of "read write".
CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  key_prefix TEXT NOT NULL,
  scopes TEXT NOT NULL DEFAULT 'read',
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  last_used_at TEXT
);
CREATE INDEX idx_api_keys_tenant ON api_keys(tenant_id);
CREATE INDEX idx_api_keys_account ON api_keys(account_id);

-- Single-use OIDC state values (hash only), consumed at the callback so a
-- state cannot be replayed even if the flow cookie is copied.
CREATE TABLE oidc_states (
  state_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL -- unix seconds
);

-- Session epochs give stateless signed cookies a revoke-all switch: the
-- epoch baked into the cookie must match the server-side value.
CREATE TABLE session_epochs (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  epoch INTEGER NOT NULL DEFAULT 0
);
