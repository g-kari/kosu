/**
 * Custom fields (phase 3): per-project field definitions and per-task
 * values. Types: text, number, date, select (options list). Values are
 * stored as text and validated against the definition on write; they
 * are structured metadata, so they stay plaintext like titles.
 */
import { nowIso } from "./accounts";
import { badRequest, notFound } from "./errors";
import { cleanName } from "./hierarchy";
import { isDateString } from "./timecalc";
import { randomId } from "./tokens";
import type { CustomFieldDefRow, Env } from "./types";

export const FIELD_TYPES = ["text", "number", "date", "select"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export function publicFieldDef(row: CustomFieldDefRow) {
  let options: string[] = [];
  if (row.options_json) {
    try {
      const parsed: unknown = JSON.parse(row.options_json);
      if (Array.isArray(parsed)) options = parsed as string[];
    } catch {
      options = [];
    }
  }
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    project_id: row.project_id,
    name: row.name,
    field_type: row.field_type,
    options,
    sort_order: Number(row.sort_order),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function parseFieldDefInput(
  body: Record<string, unknown>,
  partial: boolean,
): { name?: string; fieldType?: FieldType; options?: string[]; sortOrder?: number } {
  const out: {
    name?: string;
    fieldType?: FieldType;
    options?: string[];
    sortOrder?: number;
  } = {};
  if (!partial || body["name"] !== undefined) {
    out.name = cleanName(body["name"]);
  }
  if (!partial || body["field_type"] !== undefined) {
    const t = body["field_type"];
    if (typeof t !== "string" || !(FIELD_TYPES as readonly string[]).includes(t)) {
      throw badRequest('"field_type" must be text, number, date or select');
    }
    out.fieldType = t as FieldType;
  }
  if (body["options"] !== undefined) {
    const options = body["options"];
    if (
      !Array.isArray(options) ||
      options.length > 100 ||
      options.some(
        (o) => typeof o !== "string" || o.length < 1 || o.length > 100,
      )
    ) {
      throw badRequest('"options" must be an array of up to 100 short strings');
    }
    out.options = options as string[];
  }
  if (body["sort_order"] !== undefined) {
    const s = body["sort_order"];
    if (typeof s !== "number" || !Number.isInteger(s)) {
      throw badRequest('"sort_order" must be an integer');
    }
    out.sortOrder = s;
  }
  return out;
}

export async function createFieldDef(
  env: Env,
  input: {
    tenantId: string;
    projectId: string;
    name: string;
    fieldType: FieldType;
    options: string[];
    sortOrder: number;
    createdByAccountId: string;
  },
): Promise<CustomFieldDefRow> {
  if (input.fieldType === "select" && input.options.length === 0) {
    throw badRequest('A select field needs at least one option');
  }
  const now = nowIso();
  const row: CustomFieldDefRow = {
    id: randomId(),
    tenant_id: input.tenantId,
    project_id: input.projectId,
    name: input.name,
    field_type: input.fieldType,
    options_json:
      input.fieldType === "select" ? JSON.stringify(input.options) : null,
    sort_order: input.sortOrder,
    created_by_account_id: input.createdByAccountId,
    created_at: now,
    updated_at: now,
    deleted_at: null,
  };
  await env.DB.prepare(
    "INSERT INTO custom_field_defs (id, tenant_id, project_id, name, field_type, options_json, sort_order, created_by_account_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
  )
    .bind(
      row.id, row.tenant_id, row.project_id, row.name, row.field_type,
      row.options_json, row.sort_order, row.created_by_account_id, now, now,
    )
    .run();
  return row;
}

export async function listFieldDefs(
  env: Env,
  projectId: string,
): Promise<CustomFieldDefRow[]> {
  const res = await env.DB.prepare(
    "SELECT * FROM custom_field_defs WHERE project_id = ?1 AND deleted_at IS NULL",
  )
    .bind(projectId)
    .all<CustomFieldDefRow>();
  return res.results.sort(
    (a, b) =>
      Number(a.sort_order) - Number(b.sort_order) ||
      a.created_at.localeCompare(b.created_at),
  );
}

export async function loadFieldDef(
  env: Env,
  projectId: string,
  fieldId: string,
): Promise<CustomFieldDefRow> {
  const row = await env.DB.prepare(
    "SELECT * FROM custom_field_defs WHERE id = ?1 AND project_id = ?2 AND deleted_at IS NULL",
  )
    .bind(fieldId, projectId)
    .first<CustomFieldDefRow>();
  if (!row) throw notFound("Custom field not found");
  return row;
}

export async function deleteFieldDef(
  env: Env,
  row: CustomFieldDefRow,
): Promise<void> {
  const now = nowIso();
  await env.DB.prepare(
    "UPDATE custom_field_defs SET deleted_at = ?1, updated_at = ?2 WHERE id = ?3",
  )
    .bind(now, now, row.id)
    .run();
  await env.DB.prepare("DELETE FROM task_custom_values WHERE field_id = ?1")
    .bind(row.id)
    .run();
}

/** Validate a value against its definition; returns the stored text. */
export function validateFieldValue(
  def: CustomFieldDefRow,
  value: unknown,
): string | null {
  if (value === null || value === undefined || value === "") return null;
  switch (def.field_type) {
    case "text": {
      if (typeof value !== "string" || value.length > 2000) {
        throw badRequest(`Field "${def.name}" must be text up to 2000 characters`);
      }
      return value;
    }
    case "number": {
      const n =
        typeof value === "number"
          ? value
          : typeof value === "string" && value.trim() !== ""
            ? Number(value)
            : NaN;
      if (!Number.isFinite(n)) {
        throw badRequest(`Field "${def.name}" must be a number`);
      }
      return String(n);
    }
    case "date": {
      if (!isDateString(value)) {
        throw badRequest(`Field "${def.name}" must be a YYYY-MM-DD date`);
      }
      return value;
    }
    case "select": {
      let options: string[] = [];
      try {
        const parsed: unknown = JSON.parse(def.options_json ?? "[]");
        if (Array.isArray(parsed)) options = parsed as string[];
      } catch {
        options = [];
      }
      if (typeof value !== "string" || !options.includes(value)) {
        throw badRequest(`Field "${def.name}" must be one of its options`);
      }
      return value;
    }
    default:
      throw badRequest(`Unknown field type "${def.field_type}"`);
  }
}

export interface TaskFieldValue {
  field_id: string;
  value: string | null;
}

export async function listTaskFieldValues(
  env: Env,
  taskId: string,
): Promise<TaskFieldValue[]> {
  const res = await env.DB.prepare(
    "SELECT field_id, value_text FROM task_custom_values WHERE task_id = ?1",
  )
    .bind(taskId)
    .all<{ field_id: string; value_text: string | null }>();
  return res.results.map((r) => ({ field_id: r.field_id, value: r.value_text }));
}

export async function setTaskFieldValue(
  env: Env,
  input: {
    tenantId: string;
    taskId: string;
    def: CustomFieldDefRow;
    value: unknown;
    accountId: string;
  },
): Promise<string | null> {
  const stored = validateFieldValue(input.def, input.value);
  const now = nowIso();
  const existing = await env.DB.prepare(
    "SELECT task_id FROM task_custom_values WHERE task_id = ?1 AND field_id = ?2",
  )
    .bind(input.taskId, input.def.id)
    .first<{ task_id: string }>();
  if (existing) {
    await env.DB.prepare(
      "UPDATE task_custom_values SET value_text = ?1, updated_by_account_id = ?2, updated_at = ?3 WHERE task_id = ?4 AND field_id = ?5",
    )
      .bind(stored, input.accountId, now, input.taskId, input.def.id)
      .run();
  } else {
    await env.DB.prepare(
      "INSERT INTO task_custom_values (task_id, field_id, tenant_id, value_text, updated_by_account_id, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    )
      .bind(input.taskId, input.def.id, input.tenantId, stored, input.accountId, now)
      .run();
  }
  return stored;
}
