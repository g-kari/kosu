-- Kosu phase 4: integrations & MCP support — connection settings with
-- encrypted secrets, external-id mapping for duplicate-safe imports,
-- sync run history, task links (tenant-scoped), iCal feeds and
-- mail-inbound tokens.
--
-- Conventions kept from phases 1-3: secrets are stored only as
-- FIELD_ENCRYPTION_KEY ciphertext (`*_enc`) or as SHA-256 hashes
-- (`*_hash`); plaintext tokens are returned exactly once at creation.
-- Deletes are soft (deleted_at / revoked_at) unless noted.

-- ---------------------------------------------------------------------------
-- Task links: the table exists since 0002 but was never written. Add the
-- owning tenant and creator so the external-id uniqueness can be scoped
-- per tenant (the 0002 index was global, which would collide across
-- tenants linking the same public PR).
-- ---------------------------------------------------------------------------

ALTER TABLE links ADD COLUMN tenant_id TEXT REFERENCES tenants(id) ON DELETE CASCADE;
ALTER TABLE links ADD COLUMN created_by_account_id TEXT REFERENCES accounts(id);
DROP INDEX IF EXISTS idx_links_external;
CREATE UNIQUE INDEX idx_links_external ON links(tenant_id, kind, external_id)
  WHERE external_id IS NOT NULL;
CREATE INDEX idx_links_tenant ON links(tenant_id, kind);

-- ---------------------------------------------------------------------------
-- Integration connections (one row per provider configuration).
-- config_json holds non-secret settings (repo full name, Linear team id,
-- Slack channel label, Google calendar id, TimeCrowd base URL override).
-- secret_enc holds the provider credential: an API token for
-- linear/github/timecrowd, the Incoming Webhook URL for slack.
-- webhook_secret_enc holds the shared secret used to verify inbound
-- webhooks (linear / github); its plaintext is returned once at creation.
-- ---------------------------------------------------------------------------

CREATE TABLE integration_connections (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider TEXT NOT NULL, -- linear | github | slack | google_calendar | timecrowd
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE, -- import target (linear/github/timecrowd); NULL for tenant-level providers
  name TEXT NOT NULL,
  config_json TEXT NOT NULL DEFAULT '{}',
  secret_enc TEXT,
  webhook_secret_enc TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_by_account_id TEXT NOT NULL REFERENCES accounts(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_integrations_tenant ON integration_connections(tenant_id, provider);

-- ---------------------------------------------------------------------------
-- External item mapping: which Kosu entity an external object became.
-- The unique index makes re-syncs and re-imports idempotent.
-- ---------------------------------------------------------------------------

CREATE TABLE external_items (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connection_id TEXT, -- NULL for one-shot imports that have no connection
  provider TEXT NOT NULL, -- linear | github | timecrowd | import:toggl | import:clockify | import:kimai | import:csv | import:activitywatch
  external_id TEXT NOT NULL,
  entity_type TEXT NOT NULL, -- task | time_entry
  entity_id TEXT NOT NULL,
  external_updated_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_external_items_unique
  ON external_items(tenant_id, provider, external_id);
CREATE INDEX idx_external_items_entity ON external_items(entity_type, entity_id);

-- ---------------------------------------------------------------------------
-- Sync / import run history (the "last sync status" surface).
-- ---------------------------------------------------------------------------

CREATE TABLE integration_sync_runs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connection_id TEXT, -- NULL for one-shot imports
  provider TEXT NOT NULL,
  kind TEXT NOT NULL, -- manual | webhook | import
  status TEXT NOT NULL, -- ok | error
  stats_json TEXT NOT NULL DEFAULT '{}',
  message TEXT,
  created_by_account_id TEXT REFERENCES accounts(id),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_sync_runs_tenant ON integration_sync_runs(tenant_id, created_at);
CREATE INDEX idx_sync_runs_connection ON integration_sync_runs(connection_id, created_at);

-- ---------------------------------------------------------------------------
-- iCal feeds: a per-account, per-tenant subscription token. Only the
-- SHA-256 hash is stored; the plaintext token appears in the feed URL
-- returned once at creation.
-- ---------------------------------------------------------------------------

CREATE TABLE ical_feeds (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  label TEXT,
  created_at TEXT NOT NULL,
  last_accessed_at TEXT,
  revoked_at TEXT
);
CREATE UNIQUE INDEX idx_ical_feeds_token ON ical_feeds(token_hash);
CREATE INDEX idx_ical_feeds_account ON ical_feeds(tenant_id, account_id);

-- ---------------------------------------------------------------------------
-- Mail-inbound tokens: a per-project secret accepted by
-- POST /inbound/mail/:token (mail forwarding services POST parsed mail
-- as JSON). Only the hash is stored; the token is returned once.
-- ---------------------------------------------------------------------------

CREATE TABLE mail_inbound_tokens (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  label TEXT,
  created_by_account_id TEXT NOT NULL REFERENCES accounts(id),
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE UNIQUE INDEX idx_mail_inbound_token ON mail_inbound_tokens(token_hash);
CREATE INDEX idx_mail_inbound_project ON mail_inbound_tokens(tenant_id, project_id);
