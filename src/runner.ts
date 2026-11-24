import { toConnectionSource, type Connection, type ConnectionSource } from "./driver.ts";
import { readMigrations, type Migration } from "./migrations.ts";
import { assertSchemaName, quoteIdent, rewriteForTenant } from "./rewrite.ts";

export interface TenantMigrateOptions {
  /** A pg.Pool, a postgres.js / Bun SQL instance, or anything with `connect()`. */
  db: unknown;
  /** drizzle-kit output folder for the tenant schema (drizzle-kit 0.x or 1.x layout). */
  migrationsFolder: string;
  /** The schema name used in your Drizzle code: `pgSchema("tenant")`. Default `"tenant"`. */
  templateSchema?: string;
  /** Tracking table created inside each tenant schema. Default `"__drizzle_migrations"`. */
  migrationsTable?: string;
  /**
   * Extra schemas appended to `search_path` while a tenant migrates, so
   * hand-written SQL can use shared types and extensions. Default `["public"]`.
   */
  searchPath?: string[];
  /** Postgres `lock_timeout` per tenant, e.g. `"5s"`. Unset = server default. */
  lockTimeout?: string;
  /** Postgres `statement_timeout` per tenant, e.g. `"60s"`. Unset = server default. */
  statementTimeout?: string;
  /**
   * What to do when an applied migration's file has changed since it ran.
   * `"warn"` (default) reports it in the result; `"error"` fails that tenant.
   */
  onChangedMigration?: "warn" | "error";
  /** Called after each tenant finishes, for progress output. */
  onTenant?: (result: TenantResult) => void;
}

export interface MigrateAllOptions extends TenantMigrateOptions {
  /** Schema names, or a function that returns them (e.g. reads your tenants table). */
  tenants: string[] | (() => Promise<string[]> | string[]);
  /** How many tenants migrate at once. Each uses its own connection. Default 1. */
  concurrency?: number;
  /** Keep going after a tenant fails. Default false: no new tenants start after the first failure. */
  continueOnError?: boolean;
  /** Change nothing: return the SQL each tenant would run. */
  dryRun?: boolean;
}

export type TenantStatus = "migrated" | "up-to-date" | "failed" | "skipped" | "dry-run";

export interface TenantResult {
  schema: string;
  status: TenantStatus;
  /** Migration names applied (or, in a dry run, that would be applied). */
  applied: string[];
  /** Applied migrations whose file hash no longer matches. */
  changed: string[];
  /** SQL that ran or would run, per migration. Only filled in dry runs. */
  sql?: { migration: string; statements: string[] }[];
  error?: Error;
  durationMs: number;
}

export interface MigrateAllResult {
  tenants: TenantResult[];
  ok: boolean;
}

export interface StatusResult {
  schema: string;
  exists: boolean;
  applied: string[];
  pending: string[];
  changed: string[];
}

interface Resolved {
  source: ConnectionSource;
  migrations: Migration[];
  template: string;
  table: string;
  searchPath: string[];
  lockTimeout?: string;
  statementTimeout?: string;
  onChanged: "warn" | "error";
}

// Namespace for advisory locks so we never collide with app locks: hashtext('drizzle-tenant-migrate').
const LOCK_NS = "drizzle-tenant-migrate";

function resolve(o: TenantMigrateOptions): Resolved {
  const template = o.templateSchema ?? "tenant";
  const searchPath = o.searchPath ?? ["public"];
  return {
    source: toConnectionSource(o.db),
    migrations: readMigrations(o.migrationsFolder),
    template,
    table: o.migrationsTable ?? "__drizzle_migrations",
    searchPath,
    lockTimeout: o.lockTimeout,
    statementTimeout: o.statementTimeout,
    onChanged: o.onChangedMigration ?? "warn",
  };
}

interface AppliedRow {
  name: string | null;
  hash: string;
  created_at: string | number | null;
}

async function schemaExists(conn: Connection, schema: string): Promise<boolean> {
  const { rows } = await conn.query<{ n: number }>(
    "select 1 as n from pg_namespace where nspname = $1",
    [schema],
  );
  return rows.length > 0;
}

async function tableExists(conn: Connection, schema: string, table: string): Promise<boolean> {
  const { rows } = await conn.query<{ t: string | null }>("select to_regclass($1)::text as t", [
    `${quoteIdent(schema)}.${quoteIdent(table)}`,
  ]);
  return rows[0]?.t != null;
}

async function readApplied(conn: Connection, schema: string, table: string): Promise<AppliedRow[]> {
  const { rows } = await conn.query<AppliedRow>(
    `select to_jsonb(m)->>'name' as name, hash, created_at from ${quoteIdent(schema)}.${quoteIdent(table)} m order by id`,
  );
  return rows;
}

/**
 * Works out what is pending. A migration counts as applied if its name is
 * recorded, or (for rows written by drizzle-orm's own migrator, which has no
 * name column) if its hash is recorded.
 */
function plan(migrations: Migration[], applied: AppliedRow[]) {
  const byName = new Map<string, AppliedRow>();
  const byHash = new Set<string>();
  for (const row of applied) {
    if (row.name) byName.set(row.name, row);
    byHash.add(row.hash);
  }
  const pending: Migration[] = [];
  const done: string[] = [];
  const changed: string[] = [];
  for (const m of migrations) {
    const row = byName.get(m.name);
    if (row) {
      done.push(m.name);
      if (row.hash !== m.hash) changed.push(m.name);
    } else if (byHash.has(m.hash)) {
      done.push(m.name);
    } else {
      pending.push(m);
    }
  }
  return { pending, done, changed };
}

async function migrateOn(
  conn: Connection,
  r: Resolved,
  schema: string,
  dryRun: boolean,
): Promise<Omit<TenantResult, "durationMs">> {
  assertSchemaName(schema);
  const s = quoteIdent(schema);
  const t = `${s}.${quoteIdent(r.table)}`;

  if (dryRun) {
    const exists = (await schemaExists(conn, schema)) && (await tableExists(conn, schema, r.table));
    const applied = exists ? await readApplied(conn, schema, r.table) : [];
    const { pending, changed } = plan(r.migrations, applied);
    return {
      schema,
      status: "dry-run",
      applied: pending.map((m) => m.name),
      changed,
      sql: pending.map((m) => ({
        migration: m.name,
        statements: rewriteForTenant(m.statements, r.template, schema),
      })),
    };
  }

  await conn.query("begin");
  try {
    // One runner per tenant at a time, across processes and machines.
    await conn.query("select pg_advisory_xact_lock(hashtext($1), hashtext($2))", [LOCK_NS, schema]);
    if (r.lockTimeout) await conn.query(`set local lock_timeout = '${r.lockTimeout.replaceAll("'", "''")}'`);
    if (r.statementTimeout) {
      await conn.query(`set local statement_timeout = '${r.statementTimeout.replaceAll("'", "''")}'`);
    }
    await conn.query(`create schema if not exists ${s}`);
    await conn.query(
      `create table if not exists ${t} (id serial primary key, hash text not null, created_at bigint, name text)`,
    );
    // Tables created by drizzle-orm 0.x's migrator have no name column.
    await conn.query(`alter table ${t} add column if not exists name text`);
    await conn.query(
      `set local search_path to ${[schema, ...r.searchPath].map(quoteIdent).join(", ")}`,
    );

    const applied = await readApplied(conn, schema, r.table);
    const { pending, changed } = plan(r.migrations, applied);

    if (changed.length > 0 && r.onChanged === "error") {
      throw new Error(`Applied migrations changed on disk: ${changed.join(", ")}`);
    }

    for (const m of pending) {
      for (const stmt of rewriteForTenant(m.statements, r.template, schema)) {
        try {
          await conn.query(stmt);
        } catch (err) {
          const e = err as Error;
          e.message = `${m.name}: ${e.message}\n--- statement ---\n${stmt}`;
          throw e;
        }
      }
      await conn.query(`insert into ${t} (hash, created_at, name) values ($1, $2, $3)`, [
        m.hash,
        m.createdAt,
        m.name,
      ]);
    }

    await conn.query("commit");
    return {
      schema,
      status: pending.length > 0 ? "migrated" : "up-to-date",
      applied: pending.map((m) => m.name),
      changed,
    };
  } catch (err) {
    await conn.query("rollback").catch(() => {});
    throw err;
  }
}

async function runOne(r: Resolved, schema: string, dryRun: boolean): Promise<TenantResult> {
  const started = Date.now();
  let conn: Connection | undefined;
  try {
    conn = await r.source.connect();
    const res = await migrateOn(conn, r, schema, dryRun);
    return { ...res, durationMs: Date.now() - started };
  } catch (err) {
    return {
      schema,
      status: "failed",
      applied: [],
      changed: [],
      error: err instanceof Error ? err : new Error(String(err)),
      durationMs: Date.now() - started,
    };
  } finally {
    await conn?.release();
  }
}

/**
 * Migrates one tenant schema, creating it if needed. Use this when a new
 * tenant signs up. Throws if the migration fails; nothing is left half-applied.
 */
export async function migrateTenant(
  schema: string,
  options: TenantMigrateOptions,
): Promise<TenantResult> {
  const r = resolve(options);
  const result = await runOne(r, schema, false);
  options.onTenant?.(result);
  if (result.error) throw result.error;
  return result;
}

/** Migrates every tenant schema. Each tenant runs in its own transaction. */
export async function migrateTenants(options: MigrateAllOptions): Promise<MigrateAllResult> {
  const r = resolve(options);
  const list = typeof options.tenants === "function" ? await options.tenants() : options.tenants;
  const schemas = [...new Set(list)];
  for (const s of schemas) assertSchemaName(s);

  const concurrency = Math.max(1, Math.floor(options.concurrency ?? 1));
  const results: TenantResult[] = new Array(schemas.length);
  let next = 0;
  let stop = false;

  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= schemas.length) return;
      const schema = schemas[i]!;
      if (stop) {
        results[i] = { schema, status: "skipped", applied: [], changed: [], durationMs: 0 };
        options.onTenant?.(results[i]!);
        continue;
      }
      const res = await runOne(r, schema, options.dryRun ?? false);
      results[i] = res;
      if (res.status === "failed" && !options.continueOnError) stop = true;
      options.onTenant?.(res);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, schemas.length) }, worker));
  return { tenants: results, ok: results.every((x) => x.status !== "failed") };
}

/** Reports applied and pending migrations per tenant without changing anything. */
export async function tenantStatus(
  options: Omit<MigrateAllOptions, "concurrency" | "continueOnError" | "dryRun">,
): Promise<StatusResult[]> {
  const r = resolve(options);
  const list = typeof options.tenants === "function" ? await options.tenants() : options.tenants;
  const conn = await r.source.connect();
  try {
    const out: StatusResult[] = [];
    for (const schema of [...new Set(list)]) {
      assertSchemaName(schema);
      const exists = await schemaExists(conn, schema);
      const applied =
        exists && (await tableExists(conn, schema, r.table))
          ? await readApplied(conn, schema, r.table)
          : [];
      const p = plan(r.migrations, applied);
      out.push({
        schema,
        exists,
        applied: p.done,
        pending: p.pending.map((m) => m.name),
        changed: p.changed,
      });
    }
    return out;
  } finally {
    await conn.release();
  }
}
