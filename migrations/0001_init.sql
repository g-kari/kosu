-- Kosu initial schema.
--
-- Conventions:
-- - Primary keys are opaque internal IDs (TEXT). OIDC `sub` values are kept
--   only in accounts.oidc_sub and never exposed through screens or APIs.
-- - Timestamps are ISO 8601 UTC strings.
-- - Fields marked `*_enc` hold AES-GCM ciphertext produced by src/crypto.ts
--   (format `v1.<base64url(iv || ciphertext)>`); plaintext never reaches D1.
-- - Titles, statuses and dates stay plaintext because search and aggregation
--   need them (see docs/DESIGN.md).

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  oidc_sub TEXT NOT NULL UNIQUE,
  display_name TEXT,
  email TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_account_id TEXT NOT NULL REFERENCES accounts(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE members (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member', -- owner | member
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (workspace_id, account_id)
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description_enc TEXT,
  color TEXT,
  starts_on TEXT, -- YYYY-MM-DD
  due_on TEXT,    -- YYYY-MM-DD
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_projects_workspace ON projects(workspace_id);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
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
CREATE INDEX idx_tasks_workspace ON tasks(workspace_id);
CREATE INDEX idx_tasks_project ON tasks(project_id);
CREATE INDEX idx_tasks_parent ON tasks(parent_task_id);

CREATE TABLE time_entries (
  id TEXT PRIMARY KEY,
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

-- External links attached to a task. For synced sources (linear / github)
-- the (kind, external_id) pair doubles as the sync mapping, so re-imports
-- update the same task instead of duplicating it.
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
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  detail TEXT, -- non-secret summary only; never plaintext of *_enc fields
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_audit_workspace ON audit_log(workspace_id, created_at);
