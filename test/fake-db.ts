/**
 * Minimal in-memory D1 stand-in for route/service tests.
 *
 * Supports exactly the SQL shapes the production code uses:
 *   SELECT <cols|*> FROM t [WHERE cond [AND cond ...]] [ORDER BY col ASC|DESC]
 *   INSERT INTO t (cols) VALUES (?n, ...)
 *   UPDATE t SET col = ?n [, ...] WHERE conds
 *   DELETE FROM t WHERE conds
 * where a condition is `col <op> ?n` (op: = < > <= >=) or `col IS [NOT] NULL`.
 * Placeholders are 1-based (?1) and may repeat. Anything else throws, so
 * tests fail loudly if production SQL outgrows this subset.
 */

type Row = Record<string, unknown>;

interface Cond {
  col: string;
  op: string;
  param?: number;
}

function parseConds(where: string | undefined, sql: string): Cond[] {
  if (!where) return [];
  return where.split(/\s+AND\s+/i).map((part) => {
    const m = part.trim().match(/^(\w+)\s+(IS NOT NULL|IS NULL|=|<=|>=|<|>)\s*(?:\?(\d+))?$/i);
    if (!m) throw new Error(`FakeDb: unsupported condition "${part}" in: ${sql}`);
    return {
      col: m[1] as string,
      op: (m[2] as string).toUpperCase(),
      param: m[3] ? Number(m[3]) : undefined,
    };
  });
}

function isNumericLike(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string" && value.trim() !== "") {
    return Number.isFinite(Number(value));
  }
  return false;
}

/** Type-aware compare: numbers compare numerically, strings as strings. */
function compareValues(a: unknown, b: unknown): number {
  if (isNumericLike(a) && isNumericLike(b)) {
    const diff = Number(a) - Number(b);
    return diff < 0 ? -1 : diff > 0 ? 1 : 0;
  }
  return String(a ?? "").localeCompare(String(b ?? ""));
}

function rowMatches(row: Row, conds: Cond[], bindings: unknown[]): boolean {
  for (const cond of conds) {
    const value = row[cond.col];
    if (cond.op === "IS NULL") {
      if (value !== null && value !== undefined) return false;
      continue;
    }
    if (cond.op === "IS NOT NULL") {
      if (value === null || value === undefined) return false;
      continue;
    }
    const expected = bindings[(cond.param as number) - 1];
    const cmp = compareValues(value, expected);
    switch (cond.op) {
      case "=":
        if (cmp !== 0) return false;
        break;
      case "<":
        if (!(cmp < 0)) return false;
        break;
      case ">":
        if (!(cmp > 0)) return false;
        break;
      case "<=":
        if (!(cmp <= 0)) return false;
        break;
      case ">=":
        if (!(cmp >= 0)) return false;
        break;
      default:
        throw new Error(`FakeDb: unsupported op ${cond.op}`);
    }
  }
  return true;
}

class FakeStatement {
  private bindings: unknown[] = [];

  constructor(
    private db: FakeDb,
    private sql: string,
  ) {}

  bind(...values: unknown[]): FakeStatement {
    this.bindings = values;
    return this;
  }

  private table(name: string): Row[] {
    let rows = this.db.tables.get(name);
    if (!rows) {
      rows = [];
      this.db.tables.set(name, rows);
    }
    return rows;
  }

  private selectRows(): Row[] {
    const sql = this.sql;
    const m = sql.match(
      /^SELECT\s+(.+?)\s+FROM\s+(\w+)(?:\s+WHERE\s+(.+?))?(?:\s+ORDER\s+BY\s+(\w+)\s+(ASC|DESC))?(?:\s+LIMIT\s+(\d+))?$/i,
    );
    if (!m) throw new Error(`FakeDb: unsupported SELECT: ${sql}`);
    const cols = (m[1] as string).trim();
    const rows = this.table(m[2] as string).filter((r) =>
      rowMatches(r, parseConds(m[3], sql), this.bindings),
    );
    if (m[4]) {
      const col = m[4];
      const dir = (m[5] as string).toUpperCase() === "DESC" ? -1 : 1;
      rows.sort((a, b) => compareValues(a[col], b[col]) * dir);
    }
    if (m[6]) rows.splice(Number(m[6]));
    if (cols === "*") return rows.map((r) => ({ ...r }));
    const names = cols.split(",").map((s) => s.trim());
    return rows.map((r) => {
      const out: Row = {};
      for (const n of names) out[n] = r[n];
      return out;
    });
  }

  async first<T = Row>(): Promise<T | null> {
    const rows = this.selectRows();
    return (rows[0] as T) ?? null;
  }

  async all<T = Row>(): Promise<{ results: T[]; success: true; meta: object }> {
    return { results: this.selectRows() as T[], success: true, meta: {} };
  }

  async run(): Promise<{ success: true; meta: { changes: number } }> {
    const sql = this.sql.trim();
    let m: RegExpMatchArray | null;

    m = sql.match(/^INSERT INTO\s+(\w+)\s*\(([^)]+)\)\s*VALUES\s*\((.+)\)$/i);
    if (m) {
      const cols = (m[2] as string).split(",").map((s) => s.trim());
      // Split the VALUES list on commas outside single quotes.
      const rawValues = (m[3] as string).match(/'(?:[^']*)'|\?(\d+)|[^,]+/g) ?? [];
      const values = rawValues.map((s) => s.trim()).filter((s) => s.length > 0);
      if (values.length !== cols.length) {
        throw new Error(`FakeDb: column/value count mismatch in: ${sql}`);
      }
      const row: Row = {};
      cols.forEach((col, i) => {
        const v = values[i] as string;
        const pm = v.match(/^\?(\d+)$/);
        if (pm) {
          row[col] = this.bindings[Number(pm[1]) - 1];
        } else if (/^'[^']*'$/.test(v)) {
          row[col] = v.slice(1, -1);
        } else {
          throw new Error(`FakeDb: unsupported value ${v} in: ${sql}`);
        }
      });
      this.table(m[1] as string).push(row);
      return { success: true, meta: { changes: 1 } };
    }

    m = sql.match(/^UPDATE\s+(\w+)\s+SET\s+(.+?)\s+WHERE\s+(.+)$/i);
    if (m) {
      const sets = (m[2] as string).split(",").map((part) => {
        const sm = part.trim().match(/^(\w+)\s*=\s*\?(\d+)$/);
        if (!sm) throw new Error(`FakeDb: unsupported SET "${part}" in: ${sql}`);
        return { col: sm[1] as string, param: Number(sm[2]) };
      });
      const conds = parseConds(m[3] as string, sql);
      let changes = 0;
      for (const row of this.table(m[1] as string)) {
        if (rowMatches(row, conds, this.bindings)) {
          for (const s of sets) row[s.col] = this.bindings[s.param - 1];
          changes++;
        }
      }
      return { success: true, meta: { changes } };
    }

    m = sql.match(/^DELETE FROM\s+(\w+)\s+WHERE\s+(.+)$/i);
    if (m) {
      const conds = parseConds(m[2] as string, sql);
      const rows = this.table(m[1] as string);
      const kept = rows.filter((r) => !rowMatches(r, conds, this.bindings));
      this.db.tables.set(m[1] as string, kept);
      return { success: true, meta: { changes: rows.length - kept.length } };
    }

    throw new Error(`FakeDb: unsupported statement: ${sql}`);
  }
}

export class FakeDb {
  tables = new Map<string, Row[]>();

  prepare(sql: string): FakeStatement {
    return new FakeStatement(this, sql.replace(/\s+/g, " ").trim());
  }

  async batch(
    statements: FakeStatement[],
  ): Promise<{ success: true; meta: { changes: number } }[]> {
    const results = [];
    for (const stmt of statements) results.push(await stmt.run());
    return results;
  }

  /** Test helper: insert a row directly. */
  seed(table: string, row: Row): void {
    let rows = this.tables.get(table);
    if (!rows) {
      rows = [];
      this.tables.set(table, rows);
    }
    rows.push({ ...row });
  }

  /** Test helper: read rows directly. */
  rows(table: string): Row[] {
    return this.tables.get(table) ?? [];
  }
}

/** In-memory R2 stand-in: just enough for the attachment flows. */
export class FakeR2 {
  objects = new Map<string, { bytes: Uint8Array; contentType?: string }>();

  async put(
    key: string,
    value: ArrayBuffer | Uint8Array | ReadableStream,
    options?: { httpMetadata?: { contentType?: string } },
  ) {
    let bytes: Uint8Array;
    if (value instanceof Uint8Array) bytes = value;
    else if (value instanceof ArrayBuffer) bytes = new Uint8Array(value);
    else bytes = new Uint8Array(await new Response(value).arrayBuffer());
    this.objects.set(key, {
      bytes,
      contentType: options?.httpMetadata?.contentType,
    });
    return { key, size: bytes.length };
  }

  async get(key: string) {
    const found = this.objects.get(key);
    if (!found) return null;
    return {
      key,
      size: found.bytes.length,
      httpMetadata: { contentType: found.contentType },
      body: new ReadableStream({
        start: (controller) => {
          controller.enqueue(found.bytes);
          controller.close();
        },
      }),
      arrayBuffer: async () =>
        found.bytes.buffer.slice(
          found.bytes.byteOffset,
          found.bytes.byteOffset + found.bytes.byteLength,
        ) as ArrayBuffer,
    };
  }

  async delete(key: string) {
    this.objects.delete(key);
  }
}

const r2ByDb = new WeakMap<object, FakeR2>();

/** Build a Workers-style Env backed by a fresh FakeDb. */
export function makeEnv(db: FakeDb, files?: FakeR2) {
  // One FakeR2 per FakeDb, so objects uploaded in one request stay
  // visible to later requests in the same test.
  let bucket = files ?? r2ByDb.get(db);
  if (!bucket) {
    bucket = new FakeR2();
    r2ByDb.set(db, bucket);
  }
  return {
    DB: db as unknown as D1Database,
    FILES: bucket as unknown as R2Bucket,
    APP_ORIGIN: "https://kosu.0g0.xyz",
    OIDC_ISSUER: "https://id.0g0.xyz",
    OIDC_CLIENT_ID: "test-client",
    OIDC_SCOPES: "openid profile email",
    SESSION_SECRET: "test-session-secret",
    FIELD_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  };
}

/** Seed an account plus a session cookie value for it. */
export async function seedAccount(
  db: FakeDb,
  overrides: Partial<Row> = {},
): Promise<{ id: string }> {
  const { signValue } = await import("../src/tokens");
  const id = (overrides["id"] as string) ?? crypto.randomUUID();
  db.seed("accounts", {
    id,
    oidc_sub: `sub-${id}`,
    display_name: "テストユーザー",
    email: "user@example.com",
    created_at: "2026-11-14T00:00:00.000Z",
    updated_at: "2026-11-14T00:00:00.000Z",
    ...overrides,
  });
  return { id };
}

/** Signed session cookie header value for an account id. */
export async function sessionCookieFor(accountId: string): Promise<string> {
  const { signValue } = await import("../src/tokens");
  const value = await signValue("test-session-secret", {
    kind: "session",
    accountId,
    epoch: 0,
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  return `__Host-kosu_session=${encodeURIComponent(value)}`;
}

