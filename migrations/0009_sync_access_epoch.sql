-- Scope reassignments invalidate incremental mirrors without invalidating
-- every normal insert/edit. All writers are covered by database triggers.
CREATE TABLE sync_access_epochs (
 tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
 revision INTEGER NOT NULL DEFAULT 0
);
CREATE TRIGGER sync_entry_scope_changed AFTER UPDATE OF task_id, workspace_id, account_id ON time_entries
WHEN OLD.task_id IS NOT NEW.task_id OR OLD.workspace_id IS NOT NEW.workspace_id OR OLD.account_id IS NOT NEW.account_id
BEGIN
 INSERT INTO sync_access_epochs(tenant_id,revision) VALUES(NEW.tenant_id,1)
 ON CONFLICT(tenant_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER sync_task_scope_changed AFTER UPDATE OF project_id ON tasks
WHEN OLD.project_id IS NOT NEW.project_id
BEGIN
 INSERT INTO sync_access_epochs(tenant_id,revision) VALUES(NEW.tenant_id,1)
 ON CONFLICT(tenant_id) DO UPDATE SET revision=revision+1;
END;
