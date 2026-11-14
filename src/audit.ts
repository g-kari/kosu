/** Audit log writes. Details are non-secret summaries only. */
import { randomId } from "./tokens";
import type { Env } from "./types";

export async function recordAudit(
  env: Env,
  entry: {
    tenantId?: string | null;
    workspaceId?: string | null;
    accountId?: string | null;
    action: string;
    targetType?: string | null;
    targetId?: string | null;
    detail?: string | null;
  },
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO audit_log (id, tenant_id, workspace_id, account_id, action, target_type, target_id, detail, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
  )
    .bind(
      randomId(),
      entry.tenantId ?? null,
      entry.workspaceId ?? null,
      entry.accountId ?? null,
      entry.action,
      entry.targetType ?? null,
      entry.targetId ?? null,
      entry.detail ?? null,
      new Date().toISOString(),
    )
    .run();
}
