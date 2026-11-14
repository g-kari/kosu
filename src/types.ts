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
  /**
   * Comma-separated internal account ids of the service operators
   * (phase 5 admin console). Unset means the console is disabled.
   */
  OPERATOR_ACCOUNT_IDS?: string;
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
  priority: string;
  assignee_account_id: string | null;
  start_date: string | null;
  due_date: string | null;
  sort_order: number;
  estimate_minutes: number | null;
  estimate_points: number | null;
  estimate_size: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  archived_at: string | null;
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

/* ------------------------------------------------------------------ */
/* Phase 3 row shapes                                                   */
/* ------------------------------------------------------------------ */

export interface LabelRow {
  id: string;
  tenant_id: string;
  scope_level: string;
  workspace_id: string | null;
  project_id: string | null;
  name: string;
  color: string | null;
  created_by_account_id: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface SavedFilterRow {
  id: string;
  tenant_id: string;
  account_id: string;
  name: string;
  project_id: string | null;
  query_json: string;
  created_at: string;
  updated_at: string;
}

export interface StatusDefRow {
  id: string;
  tenant_id: string;
  scope_level: string;
  workspace_id: string | null;
  project_id: string | null;
  slug: string;
  name: string;
  category: string;
  color: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface PriorityDefRow {
  id: string;
  tenant_id: string;
  scope_level: string;
  workspace_id: string | null;
  project_id: string | null;
  slug: string;
  name: string;
  weight: number;
  color: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface CustomFieldDefRow {
  id: string;
  tenant_id: string;
  project_id: string;
  name: string;
  field_type: string;
  options_json: string | null;
  sort_order: number;
  created_by_account_id: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface TaskCommentRow {
  id: string;
  tenant_id: string;
  task_id: string;
  account_id: string;
  body_enc: string;
  mentions_json: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface AttachmentRow {
  id: string;
  tenant_id: string;
  task_id: string;
  account_id: string;
  filename: string;
  content_type: string | null;
  size_bytes: number;
  r2_key: string;
  created_at: string;
  deleted_at: string | null;
}

export interface TaskHistoryRow {
  id: string;
  tenant_id: string;
  task_id: string;
  account_id: string | null;
  action: string;
  changes_json: string;
  snapshot_json: string;
  version: number;
  created_at: string;
}

export interface RecurrenceRuleRow {
  id: string;
  tenant_id: string;
  task_id: string;
  freq: string;
  basis: string;
  interval_count: number;
  by_weekday_json: string | null;
  end_date: string | null;
  max_count: number | null;
  generated_count: number;
  active: number;
  created_by_account_id: string;
  created_at: string;
  updated_at: string;
}

export interface TaskTemplateRow {
  id: string;
  tenant_id: string;
  project_id: string;
  name: string;
  payload_json: string;
  created_by_account_id: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface LeaveRecordRow {
  id: string;
  tenant_id: string;
  account_id: string;
  date: string;
  kind: string;
  note_enc: string | null;
  created_by_account_id: string;
  created_at: string;
  deleted_at: string | null;
}

export interface TimeSubmissionRow {
  id: string;
  tenant_id: string;
  account_id: string;
  period_start: string;
  period_end: string;
  status: string;
  submitted_at: string;
  reviewed_by_account_id: string | null;
  reviewed_at: string | null;
  review_note_enc: string | null;
  created_at: string;
  updated_at: string;
}

export interface EntryChangeRequestRow {
  id: string;
  tenant_id: string;
  entry_id: string | null;
  target_account_id: string;
  requester_account_id: string;
  type: string;
  payload_json: string;
  reason_enc: string | null;
  status: string;
  decided_by_account_id: string | null;
  decided_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface NotificationRow {
  id: string;
  tenant_id: string;
  account_id: string;
  kind: string;
  title: string;
  payload_json: string;
  related_type: string | null;
  related_id: string | null;
  dedupe_key: string | null;
  read_at: string | null;
  created_at: string;
}

export interface WebhookEndpointRow {
  id: string;
  tenant_id: string;
  url: string;
  secret_enc: string;
  events_json: string;
  active: number;
  created_by_account_id: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface SyncConflictRow {
  id: string;
  tenant_id: string;
  entity_type: string;
  entity_id: string;
  server_version: number;
  client_base_version: number;
  server_payload: string | null;
  client_payload: string | null;
  account_id: string | null;
  device_id: string | null;
  status: string;
  created_at: string;
  resolved_at: string | null;
  resolved_by_account_id: string | null;
  resolution: string | null;
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

/* ------------------------------------------------------------------ */
/* Phase 4 row shapes                                                   */
/* ------------------------------------------------------------------ */

export interface LinkRow {
  id: string;
  tenant_id: string | null;
  task_id: string;
  kind: string;
  url: string;
  external_id: string | null;
  title_cache: string | null;
  created_by_account_id: string | null;
  created_at: string;
}

export interface IntegrationConnectionRow {
  id: string;
  tenant_id: string;
  provider: string;
  project_id: string | null;
  name: string;
  config_json: string;
  secret_enc: string | null;
  webhook_secret_enc: string | null;
  enabled: number;
  created_by_account_id: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface ExternalItemRow {
  id: string;
  tenant_id: string;
  connection_id: string | null;
  provider: string;
  external_id: string;
  entity_type: string;
  entity_id: string;
  external_updated_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface IntegrationSyncRunRow {
  id: string;
  tenant_id: string;
  connection_id: string | null;
  provider: string;
  kind: string;
  status: string;
  stats_json: string;
  message: string | null;
  created_by_account_id: string | null;
  created_at: string;
}

export interface IcalFeedRow {
  id: string;
  tenant_id: string;
  account_id: string;
  token_hash: string;
  label: string | null;
  created_at: string;
  last_accessed_at: string | null;
  revoked_at: string | null;
}

export interface MailInboundTokenRow {
  id: string;
  tenant_id: string;
  project_id: string;
  token_hash: string;
  label: string | null;
  created_by_account_id: string;
  created_at: string;
  revoked_at: string | null;
}

/* ------------------------------------------------------------------ */
/* Phase 5 row shapes                                                   */
/* ------------------------------------------------------------------ */

export interface AutomationRuleRow {
  id: string;
  tenant_id: string;
  project_id: string | null;
  name: string;
  trigger_kind: string;
  condition_json: string;
  actions_json: string;
  enabled: number;
  created_by_account_id: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface AutomationRunRow {
  id: string;
  tenant_id: string;
  rule_id: string;
  trigger_kind: string;
  target_type: string | null;
  target_id: string | null;
  result: string;
  detail: string | null;
  created_at: string;
}

export interface ProjectTemplateRow {
  id: string;
  tenant_id: string;
  name: string;
  payload_json: string;
  created_by_account_id: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface ReportDefinitionRow {
  id: string;
  tenant_id: string;
  name: string;
  definition_json: string;
  schedule: string;
  next_run_at: string | null;
  last_run_at: string | null;
  created_by_account_id: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface ReportRunRow {
  id: string;
  tenant_id: string;
  definition_id: string;
  report_json: string;
  created_at: string;
}

export interface EscalationSettingsRow {
  tenant_id: string;
  enabled: number;
  before_days: number;
  overdue_admin_days: number;
  repeat_days: number;
  updated_at: string;
}

export interface TenantLimitsRow {
  tenant_id: string;
  max_members: number | null;
  max_tasks: number | null;
  max_attachment_bytes: number | null;
  updated_at: string;
}

export interface UserPrefsRow {
  account_id: string;
  theme: string;
  locale: string;
  week_start: number;
  updated_at: string;
}

export interface LoginEventRow {
  id: string;
  account_id: string;
  ip: string;
  user_agent: string;
  created_at: string;
}

export interface PublicShareLinkRow {
  id: string;
  tenant_id: string;
  project_id: string;
  token_hash: string;
  label: string | null;
  expires_at: string | null;
  created_by_account_id: string;
  created_at: string;
  last_accessed_at: string | null;
  revoked_at: string | null;
}

export interface IntakeFormRow {
  id: string;
  tenant_id: string;
  project_id: string;
  token_hash: string;
  title: string | null;
  enabled: number;
  created_by_account_id: string;
  created_at: string;
  revoked_at: string | null;
}
