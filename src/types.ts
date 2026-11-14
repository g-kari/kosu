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
