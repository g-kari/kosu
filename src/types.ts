/** Shared Worker types: bindings, auth principal, and D1 row shapes. */

export interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  APP_ORIGIN: string;
  OIDC_ISSUER: string;
  OIDC_CLIENT_ID: string;
  OIDC_SCOPES?: string;
  /** Base64-encoded 32-byte key for AES-GCM field encryption (Worker secret). */
  FIELD_ENCRYPTION_KEY?: string;
  /** HMAC key for signed session / flow cookies (Worker secret). */
  SESSION_SECRET: string;
}

/** Who is calling: a browser session or an API key (the MCP front door). */
export type Principal =
  | { kind: "session"; accountId: string }
  | {
      kind: "api_key";
      accountId: string;
      tenantId: string;
      keyId: string;
      scopes: string[];
    };

export interface Variables {
  principal?: Principal;
}

export interface AccountRow {
  id: string;
  oidc_sub: string;
  display_name: string | null;
  email: string | null;
  created_at: string;
  updated_at: string;
}

export interface TenantRow {
  id: string;
  name: string;
  kind: string;
  created_by_account_id: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface WorkspaceRow {
  id: string;
  tenant_id: string;
  name: string;
  created_by_account_id: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface TeamRow {
  id: string;
  tenant_id: string;
  workspace_id: string;
  name: string;
  created_by_account_id: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface ProjectRow {
  id: string;
  tenant_id: string;
  workspace_id: string;
  team_id: string;
  name: string;
  description_enc: string | null;
  color: string | null;
  starts_on: string | null;
  due_on: string | null;
  created_by_account_id: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface TaskRow {
  id: string;
  tenant_id: string;
  workspace_id: string;
  team_id: string | null;
  project_id: string | null;
  parent_task_id: string | null;
  title: string;
  description_enc: string | null;
  status: string;
  assignee_account_id: string | null;
  start_date: string | null;
  due_date: string | null;
  sort_order: number;
  estimate_minutes: number | null;
  version: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface TimeEntryRow {
  id: string;
  tenant_id: string;
  workspace_id: string;
  task_id: string | null;
  account_id: string;
  started_at: string;
  ended_at: string | null;
  duration_seconds: number | null;
  note_enc: string | null;
  version: number;
  long_running: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface TaskDependencyRow {
  id: string;
  tenant_id: string;
  workspace_id: string;
  project_id: string;
  task_id: string;
  depends_on_task_id: string;
  version: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface MilestoneRow {
  id: string;
  tenant_id: string;
  workspace_id: string;
  project_id: string;
  name: string;
  date: string;
  version: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface SyncDeviceRow {
  id: string;
  account_id: string;
  name: string;
  platform: string | null;
  created_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
}

export interface InviteRow {
  id: string;
  tenant_id: string;
  level: string;
  workspace_id: string | null;
  team_id: string | null;
  project_id: string | null;
  email: string;
  role: string;
  token_hash: string;
  created_by_account_id: string;
  expires_at: string;
  accepted_by_account_id: string | null;
  accepted_at: string | null;
  revoked_at: string | null;
  created_at: string;
}
