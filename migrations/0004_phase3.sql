-- Kosu phase 3: production features — labels & saved filters & search,
-- custom fields, workflow (status / priority) customization, recurrence &
-- templates, comments & watchers, attachments, task history & trash,
-- reports with rates & budgets, time approval flow & period locks,
-- leave records, notifications & webhooks, conflict resolution.
--
-- Conventions kept from phases 1-2: bodies that belong to the user
-- (comment text, change-request reasons) travel as *_enc ciphertext;
-- metadata needed for lists, search and aggregation stays plaintext.
-- Deletes are soft (deleted_at) except for the explicit trash purge.

-- ---------------------------------------------------------------------------
-- Tasks: priority and archive.
-- ---------------------------------------------------------------------------

ALTER TABLE tasks ADD COLUMN priority TEXT NOT NULL DEFAULT 'medium';
ALTER TABLE tasks ADD COLUMN archived_at TEXT;
CREATE INDEX idx_tasks_archived ON tasks(project_id, archived_at);

-- ---------------------------------------------------------------------------
-- Labels (scoped: tenant | workspace | project) and task assignment.
-- ---------------------------------------------------------------------------

CREATE TABLE labels (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  scope_level TEXT NOT NULL, -- tenant | workspace | project
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT,
  created_by_account_id TEXT NOT NULL REFERENCES accounts(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_labels_tenant ON labels(tenant_id, scope_level);

CREATE TABLE task_labels (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  label_id TEXT NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (task_id, label_id)
);
CREATE INDEX idx_task_labels_label ON task_labels(label_id);

-- ---------------------------------------------------------------------------
-- Saved filters (per account). query_json holds the filter parameter set
-- understood by the task list endpoint.
-- ---------------------------------------------------------------------------

CREATE TABLE saved_filters (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  query_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_saved_filters_account ON saved_filters(tenant_id, account_id);

-- ---------------------------------------------------------------------------
-- Workflow customization: status and priority definitions per scope.
-- A scope with no rows inherits from the next wider scope, then the
-- built-in defaults (see src/workflow.ts).
-- ---------------------------------------------------------------------------

CREATE TABLE status_defs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  scope_level TEXT NOT NULL, -- tenant | workspace | project
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'open', -- open | doing | done
  color TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_status_defs_scope
  ON status_defs(tenant_id, scope_level, workspace_id, project_id);

CREATE TABLE priority_defs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  scope_level TEXT NOT NULL, -- tenant | workspace | project
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  weight INTEGER NOT NULL DEFAULT 0,
  color TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_priority_defs_scope
  ON priority_defs(tenant_id, scope_level, workspace_id, project_id);

-- ---------------------------------------------------------------------------
-- Custom fields: definitions per project, values per task.
-- field_type: text | number | date | select (options_json for select).
-- ---------------------------------------------------------------------------

CREATE TABLE custom_field_defs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  field_type TEXT NOT NULL,
  options_json TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_by_account_id TEXT NOT NULL REFERENCES accounts(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_custom_fields_project ON custom_field_defs(project_id);

CREATE TABLE task_custom_values (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  field_id TEXT NOT NULL REFERENCES custom_field_defs(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  value_text TEXT,
  updated_by_account_id TEXT REFERENCES accounts(id),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (task_id, field_id)
);

-- ---------------------------------------------------------------------------
-- Comments (body is client-encrypted) and watchers.
-- Mentions are account ids validated server-side against tenant
-- membership; the server cannot read the ciphertext body, so the
-- client supplies the mention list explicitly.
-- ---------------------------------------------------------------------------

CREATE TABLE task_comments (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  body_enc TEXT NOT NULL,
  mentions_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_task_comments_task ON task_comments(task_id, created_at);

CREATE TABLE task_watchers (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (task_id, account_id)
);

-- ---------------------------------------------------------------------------
-- Attachments (bytes in R2, metadata here).
-- ---------------------------------------------------------------------------

CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  filename TEXT NOT NULL,
  content_type TEXT,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  r2_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_attachments_task ON attachments(task_id);

-- ---------------------------------------------------------------------------
-- Task history: one row per mutation, with a full public snapshot so a
-- task can be restored to any earlier version.
-- ---------------------------------------------------------------------------

CREATE TABLE task_history (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  account_id TEXT REFERENCES accounts(id),
  action TEXT NOT NULL, -- create | update | delete | restore | archive | unarchive
  changes_json TEXT NOT NULL DEFAULT '{}',
  snapshot_json TEXT NOT NULL,
  version INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_task_history_task ON task_history(task_id, created_at);

-- ---------------------------------------------------------------------------
-- Recurrence rules (one active rule per task; completion of a task with
-- an active rule spawns the next occurrence and moves the rule to it)
-- and task templates (blueprints with day offsets for dates).
-- ---------------------------------------------------------------------------

CREATE TABLE recurrence_rules (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
  freq TEXT NOT NULL, -- daily | weekly | monthly
  interval_count INTEGER NOT NULL DEFAULT 1,
  by_weekday_json TEXT, -- JSON array of ISO weekdays (weekly only)
  end_date TEXT,
  max_count INTEGER,
  generated_count INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_by_account_id TEXT NOT NULL REFERENCES accounts(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE task_templates (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_by_account_id TEXT NOT NULL REFERENCES accounts(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_task_templates_project ON task_templates(project_id);

-- Recently viewed tasks/projects per account (for the "recent" list).
CREATE TABLE recent_views (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL, -- task | project
  entity_id TEXT NOT NULL,
  viewed_at TEXT NOT NULL,
  PRIMARY KEY (account_id, entity_type, entity_id)
);

-- ---------------------------------------------------------------------------
-- Rates, budgets, leave.
-- ---------------------------------------------------------------------------

CREATE TABLE member_rates (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  rate_cents_per_hour INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'JPY',
  updated_by_account_id TEXT REFERENCES accounts(id),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, account_id)
);

CREATE TABLE project_budgets (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  budget_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'JPY',
  updated_by_account_id TEXT REFERENCES accounts(id),
  updated_at TEXT NOT NULL
);

CREATE TABLE leave_records (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  date TEXT NOT NULL, -- YYYY-MM-DD
  kind TEXT NOT NULL DEFAULT 'vacation', -- vacation | absence | sick | other
  note_enc TEXT,
  created_by_account_id TEXT NOT NULL REFERENCES accounts(id),
  created_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_leave_tenant_account ON leave_records(tenant_id, account_id, date);

-- ---------------------------------------------------------------------------
-- Time approval flow: submissions cover a date period for one account.
-- status: submitted | approved | rejected (absence of a row = draft).
-- Period locks freeze a whole month (YYYY-MM) for everyone.
-- ---------------------------------------------------------------------------

CREATE TABLE time_submissions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  period_start TEXT NOT NULL, -- YYYY-MM-DD, inclusive
  period_end TEXT NOT NULL,   -- YYYY-MM-DD, inclusive
  status TEXT NOT NULL DEFAULT 'submitted',
  submitted_at TEXT NOT NULL,
  reviewed_by_account_id TEXT REFERENCES accounts(id),
  reviewed_at TEXT,
  review_note_enc TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_submissions_account
  ON time_submissions(tenant_id, account_id, status);

CREATE TABLE period_locks (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  period TEXT NOT NULL, -- YYYY-MM
  locked_by_account_id TEXT NOT NULL REFERENCES accounts(id),
  locked_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, period)
);

-- Correction requests against (possibly frozen) time entries, and proxy
-- input requests. type: edit | create | delete. On approval the change
-- is applied by the decider, bypassing the freeze.
CREATE TABLE entry_change_requests (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  entry_id TEXT REFERENCES time_entries(id) ON DELETE CASCADE,
  target_account_id TEXT NOT NULL REFERENCES accounts(id),
  requester_account_id TEXT NOT NULL REFERENCES accounts(id),
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  reason_enc TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected
  decided_by_account_id TEXT REFERENCES accounts(id),
  decided_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_change_requests_tenant
  ON entry_change_requests(tenant_id, status);

-- ---------------------------------------------------------------------------
-- Notifications (in-app), per-account channel preferences with quiet
-- hours, tenant webhook endpoints and a delivery log.
-- ---------------------------------------------------------------------------

CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  related_type TEXT,
  related_id TEXT,
  dedupe_key TEXT,
  read_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_notifications_account
  ON notifications(account_id, read_at, created_at);
CREATE UNIQUE INDEX idx_notifications_dedupe
  ON notifications(account_id, dedupe_key) WHERE dedupe_key IS NOT NULL;

CREATE TABLE notification_prefs (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  prefs_json TEXT NOT NULL DEFAULT '{}',
  quiet_start_min INTEGER, -- minutes after local midnight; NULL = no quiet hours
  quiet_end_min INTEGER,
  tz_offset_minutes INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_id, tenant_id)
);

CREATE TABLE webhook_endpoints (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  secret_enc TEXT NOT NULL, -- signing secret, FIELD_ENCRYPTION_KEY-encrypted
  events_json TEXT NOT NULL DEFAULT '[]',
  active INTEGER NOT NULL DEFAULT 1,
  created_by_account_id TEXT NOT NULL REFERENCES accounts(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_webhooks_tenant ON webhook_endpoints(tenant_id);

CREATE TABLE webhook_deliveries (
  id TEXT PRIMARY KEY,
  endpoint_id TEXT NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  event TEXT NOT NULL,
  recipient_account_id TEXT REFERENCES accounts(id),
  payload_json TEXT NOT NULL,
  status_code INTEGER,
  error TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_webhook_deliveries_endpoint
  ON webhook_deliveries(endpoint_id, created_at);

-- Conflict resolution bookkeeping (the conflicts table itself is 0003).
ALTER TABLE sync_conflicts ADD COLUMN resolved_by_account_id TEXT;
ALTER TABLE sync_conflicts ADD COLUMN resolution TEXT; -- server | client
