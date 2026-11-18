-- Database-side limits close concurrent creation races. No existing data is removed.
CREATE TRIGGER IF NOT EXISTS report_definition_capacity BEFORE INSERT ON report_definitions
WHEN (SELECT COUNT(*) FROM report_definitions WHERE tenant_id = NEW.tenant_id) >= 100
BEGIN SELECT RAISE(ABORT, 'Stored report definition capacity reached'); END;
CREATE TRIGGER IF NOT EXISTS report_run_capacity BEFORE INSERT ON report_runs
WHEN (SELECT COUNT(*) FROM report_runs WHERE tenant_id = NEW.tenant_id) >= 1000
BEGIN SELECT RAISE(ABORT, 'Stored report run capacity reached'); END;
