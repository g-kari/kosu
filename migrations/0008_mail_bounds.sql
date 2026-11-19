-- Enforce configured task limits atomically, including non-REST task producers.
-- No existing rows are changed or removed.
CREATE TRIGGER IF NOT EXISTS tenant_task_capacity BEFORE INSERT ON tasks
WHEN NEW.deleted_at IS NULL AND
  (SELECT max_tasks FROM tenant_limits WHERE tenant_id = NEW.tenant_id) IS NOT NULL AND
  (SELECT COUNT(*) FROM tasks WHERE tenant_id = NEW.tenant_id AND deleted_at IS NULL) >=
  (SELECT max_tasks FROM tenant_limits WHERE tenant_id = NEW.tenant_id)
BEGIN SELECT RAISE(ABORT, 'Tenant task capacity reached'); END;
-- Public mail intake is bounded even when an administrator opted out of a total quota.
CREATE TRIGGER IF NOT EXISTS mail_inbound_rate BEFORE INSERT ON tasks
WHEN NEW.id GLOB 'mail_*' AND
  (SELECT COUNT(*) FROM tasks WHERE tenant_id = NEW.tenant_id AND id GLOB 'mail_*' AND
    created_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 hour')) >= 60
BEGIN SELECT RAISE(ABORT, 'Mail inbound rate limit reached'); END;

-- Receipts survive task purge so a stable upstream ID cannot recreate purged mail.
CREATE TABLE mail_receipts (
 id TEXT PRIMARY KEY,
 tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
 task_id TEXT NOT NULL,
 created_at TEXT NOT NULL
);
