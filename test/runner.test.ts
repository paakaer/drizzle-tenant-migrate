import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import pg from "pg";
import postgres from "postgres";
import { migrateTenant, migrateTenants, tenantStatus } from "../src/index.ts";

const url = process.env.DATABASE_URL;
const fixtures = join(import.meta.dirname, "fixtures");
const kit0 = join(fixtures, "kit-0x");
const kit1 = join(fixtures, "kit-1x");

/** A copy of the 0.x fixture with only the first migration in the journal. */
function firstOnly(): string {
  const dir = mkdtempSync(join(tmpdir(), "dtm-"));
  cpSync(kit0, dir, { recursive: true });
  const journalPath = join(dir, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  journal.entries = journal.entries.slice(0, 1);
  writeFileSync(journalPath, JSON.stringify(journal));
  return dir;
}

describe("against Postgres", { skip: url ? false : "set DATABASE_URL to run" }, () => {
  let pool: pg.Pool;
  let n = 0;
  const fresh = (label: string) => `t_${label}_${process.pid}_${n++}`;
  const q = async <T = Record<string, unknown>>(text: string, params?: unknown[]) =>
    (await pool.query(text, params)).rows as T[];

  before(() => {
    pool = new pg.Pool({ connectionString: url, max: 10 });
  });
  after(async () => {
    const schemas = await q<{ s: string }>(
      `select nspname as s from pg_namespace where nspname like 't\\_%\\_${process.pid}\\_%'`,
    );
    for (const { s } of schemas) await pool.query(`drop schema "${s}" cascade`);
    await pool.end();
  });

  test("migrates each tenant into its own schema, with FKs and enums kept inside it", async () => {
    const tenants = [fresh("a"), fresh("b"), fresh("c")];
    const res = await migrateTenants({ db: pool, migrationsFolder: kit0, tenants, concurrency: 2 });
    assert.equal(res.ok, true);
    assert.deepEqual(res.tenants.map((t) => t.status), ["migrated", "migrated", "migrated"]);

    for (const s of tenants) {
      const fk = await q<{ target: string }>(
        `select n.nspname as target from pg_constraint c
           join pg_class t on t.oid = c.confrelid join pg_namespace n on n.oid = t.relnamespace
           join pg_class o on o.oid = c.conrelid join pg_namespace on2 on on2.oid = o.relnamespace
          where c.contype = 'f' and on2.nspname = $1`,
        [s],
      );
      assert.deepEqual(fk, [{ target: s }]);
      const col = await q<{ udt_schema: string }>(
        `select udt_schema from information_schema.columns where table_schema = $1 and table_name = 'orders' and column_name = 'status'`,
        [s],
      );
      assert.deepEqual(col, [{ udt_schema: s }]);
    }

    await pool.query(`insert into "${tenants[0]}".customers (name, email) values ('x', 'x@y')`);
    const other = await q(`select * from "${tenants[1]}".customers`);
    assert.equal(other.length, 0);
    // The template schema itself is never created.
    assert.equal((await q(`select 1 from pg_namespace where nspname = 'tenant'`)).length, 0);
  });

  test("second run is a no-op", async () => {
    const s = fresh("idem");
    await migrateTenant(s, { db: pool, migrationsFolder: kit0 });
    const res = await migrateTenant(s, { db: pool, migrationsFolder: kit0 });
    assert.equal(res.status, "up-to-date");
    const rows = await q(`select name from "${s}".__drizzle_migrations order by id`);
    assert.deepEqual(rows, [{ name: "0000_init" }, { name: "0001_add_email" }]);
  });

  test("status shows pending migrations, then migrate catches up", async () => {
    const s = fresh("st");
    await migrateTenant(s, { db: pool, migrationsFolder: firstOnly() });
    const missing = fresh("missing");
    const status = await tenantStatus({ db: pool, migrationsFolder: kit0, tenants: [s, missing] });
    assert.deepEqual(status, [
      { schema: s, exists: true, applied: ["0000_init"], pending: ["0001_add_email"], changed: [] },
      { schema: missing, exists: false, applied: [], pending: ["0000_init", "0001_add_email"], changed: [] },
    ]);
    const res = await migrateTenant(s, { db: pool, migrationsFolder: kit0 });
    assert.deepEqual(res.applied, ["0001_add_email"]);
  });

  test("a failing tenant rolls back completely and stops the rest", async () => {
    const [a, bad, c] = [fresh("ok"), fresh("bad"), fresh("after")];
    await pool.query(`create schema "${bad}"; create table "${bad}".orders (x int)`);
    const res = await migrateTenants({ db: pool, migrationsFolder: kit0, tenants: [a, bad, c] });
    assert.equal(res.ok, false);
    assert.deepEqual(res.tenants.map((t) => t.status), ["migrated", "failed", "skipped"]);
    assert.match(res.tenants[1]!.error!.message, /0000_init: relation "orders" already exists/);
    // Nothing from the failed run survived: no customers table, no tracking table.
    const left = await q(`select table_name from information_schema.tables where table_schema = $1 order by 1`, [bad]);
    assert.deepEqual(left, [{ table_name: "orders" }]);
    assert.equal((await q(`select 1 from pg_namespace where nspname = $1`, [c])).length, 0);
  });

  test("continueOnError migrates the others", async () => {
    const [bad, c] = [fresh("bad2"), fresh("after2")];
    await pool.query(`create schema "${bad}"; create table "${bad}".orders (x int)`);
    const res = await migrateTenants({
      db: pool,
      migrationsFolder: kit0,
      tenants: [bad, c],
      continueOnError: true,
    });
    assert.deepEqual(res.tenants.map((t) => t.status), ["failed", "migrated"]);
  });

  test("two runners on the same tenant apply each migration once", async () => {
    const s = fresh("race");
    const run = () => migrateTenants({ db: pool, migrationsFolder: kit0, tenants: [s] });
    const [r1, r2] = await Promise.all([run(), run()]);
    assert.ok(r1.ok && r2.ok);
    const statuses = [r1.tenants[0]!.status, r2.tenants[0]!.status].sort();
    assert.deepEqual(statuses, ["migrated", "up-to-date"]);
    const rows = await q(`select count(*)::int as n from "${s}".__drizzle_migrations`);
    assert.deepEqual(rows, [{ n: 2 }]);
  });

  test("dry run returns rewritten SQL and changes nothing", async () => {
    const s = fresh("dry");
    const res = await migrateTenants({ db: pool, migrationsFolder: kit0, tenants: [s], dryRun: true });
    const t = res.tenants[0]!;
    assert.equal(t.status, "dry-run");
    assert.deepEqual(t.applied, ["0000_init", "0001_add_email"]);
    assert.ok(t.sql![0]!.statements.some((x) => x.includes(`REFERENCES "${s}"."customers"`)));
    assert.equal((await q(`select 1 from pg_namespace where nspname = $1`, [s])).length, 0);
  });

  test("a migration edited after it ran is reported, and fails in strict mode", async () => {
    const s = fresh("edit");
    const dir = firstOnly();
    await migrateTenant(s, { db: pool, migrationsFolder: dir });
    writeFileSync(join(dir, "0000_init.sql"), `${readFileSync(join(dir, "0000_init.sql"), "utf8")}\n-- edited`);
    const warn = await migrateTenant(s, { db: pool, migrationsFolder: dir });
    assert.deepEqual(warn.changed, ["0000_init"]);
    await assert.rejects(
      migrateTenant(s, { db: pool, migrationsFolder: dir, onChangedMigration: "error" }),
      /changed on disk: 0000_init/,
    );
  });

  test("adopts a tracking table written by drizzle-orm's own migrator", async () => {
    const s = fresh("adopt");
    const dir = firstOnly();
    const [init] = (await import("../src/migrations.ts")).readMigrations(dir);
    // What drizzle-orm 0.x leaves behind: no name column, just hash + created_at.
    await pool.query(`create schema "${s}"`);
    for (const stmt of init!.statements.slice(1)) await pool.query(stmt.replaceAll('"tenant".', `"${s}".`));
    await pool.query(`create table "${s}".__drizzle_migrations (id serial primary key, hash text not null, created_at bigint)`);
    await pool.query(`insert into "${s}".__drizzle_migrations (hash, created_at) values ($1, $2)`, [init!.hash, init!.createdAt]);

    const res = await migrateTenant(s, { db: pool, migrationsFolder: kit0 });
    assert.deepEqual(res.applied, ["0001_add_email"]);
  });

  test("works with postgres.js and the drizzle-kit 1.x layout", async () => {
    const sql = postgres(url!, { max: 3, onnotice: () => {} });
    try {
      const tenants = [fresh("pjs1"), fresh("pjs2")];
      const res = await migrateTenants({ db: sql, migrationsFolder: kit1, tenants, concurrency: 2 });
      assert.equal(res.ok, true, res.tenants.map((t) => t.error?.message).join("\n"));
      const cols = await q(
        `select column_name from information_schema.columns where table_schema = $1 and table_name = 'customers' order by ordinal_position`,
        [tenants[1]],
      );
      assert.deepEqual(cols.map((c) => c.column_name), ["id", "name", "email"]);
      const again = await migrateTenants({ db: sql, migrationsFolder: kit1, tenants });
      assert.deepEqual(again.tenants.map((t) => t.status), ["up-to-date", "up-to-date"]);
    } finally {
      await sql.end();
    }
  });
});
