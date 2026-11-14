-- Kosu phase 5: automation rules, project templates, custom report
-- definitions with schedules, deadline escalation settings, tenant
-- usage limits, per-account display preferences, login events, public
-- share links, public intake forms and onboarding sample tracking.
--
-- Conventions kept from phases 1-4: secrets are stored only as
-- ciphertext (`*_enc`) or SHA-256 hashes (`*_hash`); plaintext tokens
-- are returned exactly once at creation. Deletes are soft
-- (deleted_at / revoked_at) unless the table documents a physical
-- purge path (account deletion / tenant dissolution in src/purge.ts).

-- ---------------------------------------------------------------------------
-- Estimate units (phase 5 item 5): story points and T-shirt sizes live
-- next to the minute-based estimate; either or both may be set.
-- ---------------------------------------------------------------------------

ALTER TABLE tasks ADD COLUMN estimate_points REAL;
ALTER TABLE tasks ADD COLUMN estimate_size TEXT;

-- ---------------------------------------------------------------------------
-- Completion-based recurrence (phase 5 item 3): basis = 'schedule'
-- (phase 3 behaviour: next dates derive from the previous due/start)
-- or 'completion' (next dates derive from the completion date,
-- preserving the previous start->due duration).
-- ---------------------------------------------------------------------------

ALTER TABLE recurrence_rules ADD COLUMN basis TEXT NOT NULL DEFAULT 'schedule';

-- ---------------------------------------------------------------------------
-- API key IP allowlist (phase 5 item 12): comma-separated IPs / IPv4
-- CIDRs. NULL or empty means unrestricted.
-- ---------------------------------------------------------------------------

ALTER TABLE api_keys ADD COLUMN ip_allowlist TEXT;

-- ---------------------------------------------------------------------------
-- Automation rules (phase 5 item 1). trigger_kind is one of
-- task_created | task_status_changed | task_assigned | pr_merged.
-- condition_json: { from_status?, to_status?, assignee_account_id? }
-- actions_json: [{ type: set_status, status } |
--                { type: set_assignee, account_id } |
--                { type: notify, recipient: assignee|watchers|tenant_admins }]
-- project_id NULL means the rule applies tenant-wide.
-- ---------------------------------------------------------------------------

CREATE TABLE automation_rules (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  trigger_kind TEXT NOT NULL,
  condition_json TEXT NOT NULL DEFAULT '{}',
  actions_json TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_by_account_id TEXT NOT NULL REFERENCES accounts(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_automation_rules_tenant ON automation_rules(tenant_id, trigger_kind);

CREATE TABLE automation_runs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  rule_id TEXT NOT NULL,
  trigger_kind TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  result TEXT NOT NULL, -- ok | error
  detail TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_automation_runs_tenant ON automation_runs(tenant_id, created_at);

-- ---------------------------------------------------------------------------
-- Project templates (phase 5 item 2): a whole project blueprint
-- (tasks with relative dates, dependencies, milestones) as JSON.
-- Dates in the payload are day offsets from the capture base date.
-- ---------------------------------------------------------------------------

CREATE TABLE project_templates (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_by_account_id TEXT NOT NULL REFERENCES accounts(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_project_templates_tenant ON project_templates(tenant_id);

-- ---------------------------------------------------------------------------
-- Custom report definitions (phase 5 item 4). definition_json mirrors
-- the phase-3 report parameters plus a range spec:
-- { group_by, range: { kind: last_days|this_month|last_month|custom,
--                      days?, from?, to? }, project_id?, account_id? }
-- schedule: off | daily | weekly | monthly. Runs keep the built
-- report JSON so delivery does not depend on later data changes.
-- ---------------------------------------------------------------------------

CREATE TABLE report_definitions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  definition_json TEXT NOT NULL,
  schedule TEXT NOT NULL DEFAULT 'off',
  next_run_at TEXT,
  last_run_at TEXT,
  created_by_account_id TEXT NOT NULL REFERENCES accounts(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_report_definitions_tenant ON report_definitions(tenant_id);

CREATE TABLE report_runs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  definition_id TEXT NOT NULL,
  report_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_report_runs_definition ON report_runs(definition_id, created_at);

-- ---------------------------------------------------------------------------
-- Deadline escalation settings (phase 5 item 6): one row per tenant.
-- The basic reminders of phase 3 always run; escalation stages are
-- opt-in per tenant (enabled = 0 by default).
-- ---------------------------------------------------------------------------

CREATE TABLE escalation_settings (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 0,
  before_days INTEGER NOT NULL DEFAULT 3,
  overdue_admin_days INTEGER NOT NULL DEFAULT 1,
  repeat_days INTEGER NOT NULL DEFAULT 2,
  updated_at TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Tenant usage limits (phase 5 item 11). NULL means unlimited.
-- ---------------------------------------------------------------------------

CREATE TABLE tenant_limits (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  max_members INTEGER,
  max_tasks INTEGER,
  max_attachment_bytes INTEGER,
  updated_at TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Per-account display preferences (phase 5 items 8-9): theme
-- (system|light|dark), locale (ja|en), week_start (ISO weekday 1-7).
-- ---------------------------------------------------------------------------

CREATE TABLE user_prefs (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  theme TEXT NOT NULL DEFAULT 'system',
  locale TEXT NOT NULL DEFAULT 'ja',
  week_start INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Login events (phase 5 item 13): one row per completed OIDC login,
-- used to detect logins from a new device / IP.
-- ---------------------------------------------------------------------------

CREATE TABLE login_events (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  ip TEXT NOT NULL,
  user_agent TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_login_events_account ON login_events(account_id, created_at);

-- ---------------------------------------------------------------------------
-- Public share links (phase 5 item 16): read-only project progress
-- pages addressed by an unguessable token (hash stored).
-- ---------------------------------------------------------------------------

CREATE TABLE public_share_links (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  label TEXT,
  expires_at TEXT,
  created_by_account_id TEXT NOT NULL REFERENCES accounts(id),
  created_at TEXT NOT NULL,
  last_accessed_at TEXT,
  revoked_at TEXT
);
CREATE UNIQUE INDEX idx_share_links_token ON public_share_links(token_hash);
CREATE INDEX idx_share_links_project ON public_share_links(tenant_id, project_id);

-- ---------------------------------------------------------------------------
-- Public intake forms (phase 5 item 17): per-project token URL that
-- accepts a task title from anyone. Submissions are logged (one row
-- per accepted submission) which doubles as the rate-limit counter.
-- ---------------------------------------------------------------------------

CREATE TABLE intake_forms (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  title TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_by_account_id TEXT NOT NULL REFERENCES accounts(id),
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE UNIQUE INDEX idx_intake_forms_token ON intake_forms(token_hash);
CREATE INDEX idx_intake_forms_project ON intake_forms(tenant_id, project_id);

CREATE TABLE intake_submissions (
  id TEXT PRIMARY KEY,
  form_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  task_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_intake_submissions_form ON intake_submissions(form_id, created_at);

-- ---------------------------------------------------------------------------
-- Onboarding sample data (phase 5 item 21): which project was created
-- as the sample for an account, so it can be removed again.
-- ---------------------------------------------------------------------------

CREATE TABLE sample_projects (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (account_id, tenant_id)
);

-- ---------------------------------------------------------------------------
-- Indexes for the large-tenant read paths (phase 5 item 15).
-- ---------------------------------------------------------------------------

CREATE INDEX idx_tasks_project_order ON tasks(project_id, sort_order, created_at, id);
CREATE INDEX idx_tasks_tenant_due ON tasks(tenant_id, due_date);
CREATE INDEX idx_entries_tenant_account_started ON time_entries(tenant_id, account_id, started_at);
