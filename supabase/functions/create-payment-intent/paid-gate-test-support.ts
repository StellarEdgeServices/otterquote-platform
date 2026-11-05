/**
 * [gh-3356] Test support, imported only by *.test.ts: a fake Supabase client that REJECTS a column the real table does not have, with the
 * table's columns read from supabase/migrations (not hand-typed), so a misspelled column in a select, filter or insert fails a test the
 * way PostgREST would fail it in production (HTTP 400 / 42703). Nothing here ships in a request path.
 */

const MIGRATIONS = new URL("../../migrations/", import.meta.url);

let cachedSql: string | null = null;
async function allMigrationSql(): Promise<string> {
  if (cachedSql !== null) return cachedSql;
  const parts: string[] = [];
  for await (const e of Deno.readDir(MIGRATIONS)) {
    if (e.isFile && e.name.endsWith(".sql")) parts.push(await Deno.readTextFile(new URL(e.name, MIGRATIONS)));
  }
  cachedSql = parts.join("\n;\n");
  return cachedSql;
}

/** The columns of `table`: its CREATE TABLE block plus every `ALTER TABLE ... ADD COLUMN` in the migrations. */
export async function tableColumns(table: string): Promise<Set<string>> {
  const sql = await allMigrationSql();
  const cols = new Set<string>();
  const create = new RegExp(`CREATE TABLE(?: IF NOT EXISTS)?\\s+(?:public\\.)?${table}\\s*\\(([\\s\\S]*?)\\n\\);`, "g");
  for (const m of sql.matchAll(create)) {
    for (const line of m[1].split("\n")) {
      const c = line.match(/^\s+"?([a-z_][a-z0-9_]*)"?\s+[A-Za-z]/);
      if (c && !/^(constraint|primary|foreign|unique|check|like)$/i.test(c[1])) cols.add(c[1]);
    }
  }
  const alter = new RegExp(`ALTER TABLE\\s+(?:IF EXISTS\\s+)?(?:ONLY\\s+)?(?:public\\.)?${table}\\b([^;]*);`, "g");
  for (const m of sql.matchAll(alter)) {
    for (const c of m[1].matchAll(/ADD COLUMN(?:\s+IF NOT EXISTS)?\s+"?([a-z_][a-z0-9_]*)"?/gi)) cols.add(c[1]);
  }
  return cols;
}

export type Row = Record<string, unknown>;

/**
 * A minimal chainable, thenable stand-in for the supabase-js query builder: select / eq / not / ilike / gte / limit / insert, with every
 * column name checked against `schema`. A bad column makes the awaited result `{data: null, error: {code: "42703", ...}}`.
 */
export function fakeSupabase(
  schema: Record<string, Set<string>>,
  tables: Record<string, Row[]>,
  failures: { selectError?: Partial<Record<string, unknown>> } = {},
) {
  const calls: { table: string; op: string; detail: string }[] = [];
  return {
    calls,
    from(table: string) {
      const known = schema[table];
      const q = { select: null as string[] | null, filters: [] as ((r: Row) => boolean)[], badColumn: null as string | null, limit: Infinity, op: "select" as "select" | "insert", row: null as Row | null };
      const check = (col: string) => { if (!known || !known.has(col)) q.badColumn ??= col; };
      const run = (): { data: unknown; error: unknown } => {
        if (!known) return { data: null, error: { code: "42P01", message: `relation "${table}" does not exist` } };
        if (q.badColumn) return { data: null, error: { code: "42703", message: `column "${q.badColumn}" does not exist on ${table}` } };
        if (q.op === "insert") { (tables[table] ??= []).push({ ...q.row! }); return { data: null, error: null }; }
        if (failures.selectError?.[table]) return { data: null, error: failures.selectError[table] };
        const rows = (tables[table] ?? []).filter((r) => q.filters.every((f) => f(r))).slice(0, q.limit);
        return { data: rows.map((r) => (q.select ? Object.fromEntries(q.select.map((c) => [c, r[c] ?? null])) : r)), error: null };
      };
      const chain = {
        select(cols: string) { q.select = cols.split(",").map((c) => c.trim()); q.select.forEach(check); calls.push({ table, op: "select", detail: cols }); return chain; },
        eq(col: string, v: unknown) { check(col); q.filters.push((r) => r[col] === v); return chain; },
        not(col: string, op: string, v: unknown) { check(col); if (op === "is" && v === null) q.filters.push((r) => r[col] !== null && r[col] !== undefined); return chain; },
        ilike(col: string, pat: string) { check(col); const needle = pat.replaceAll("%", "").toLowerCase(); q.filters.push((r) => String(r[col] ?? "").toLowerCase().includes(needle)); return chain; },
        gte(col: string, v: unknown) { check(col); q.filters.push((r) => String(r[col] ?? "") >= String(v)); return chain; },
        limit(n: number) { q.limit = n; return chain; },
        insert(row: Row) { q.op = "insert"; q.row = row; Object.keys(row).forEach(check); calls.push({ table, op: "insert", detail: Object.keys(row).join(",") }); return chain; },
        // deno-lint-ignore no-explicit-any
        then(resolve: (v: { data: unknown; error: unknown }) => any, reject?: (e: unknown) => any) { try { return Promise.resolve(run()).then(resolve, reject); } catch (e) { return Promise.reject(e).then(resolve, reject); } },
      };
      return chain;
    },
  };
}
