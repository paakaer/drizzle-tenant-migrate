#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { toConnectionSource, type ConnectionSource } from "./driver.ts";
import { migrateTenants, tenantStatus, type TenantResult } from "./runner.ts";

const HELP = `drizzle-tenant-migrate: run Drizzle migrations in every tenant schema

Usage:
  drizzle-tenant-migrate migrate [options]
  drizzle-tenant-migrate status  [options]

Tenants (pick one):
  --tenants a,b,c          Comma-separated schema names
  --tenants-query "SQL"    Query whose first column is the schema name
  --tenants-file path      One schema name per line

Options:
  --url URL                Postgres URL (default: $DATABASE_URL)
  --dir path               drizzle-kit output folder for tenant tables (default: ./drizzle/tenant)
  --template name          Schema name used in pgSchema() (default: tenant)
  --table name             Tracking table in each schema (default: __drizzle_migrations)
  --concurrency n          Tenants migrated in parallel (default: 1)
  --continue-on-error      Keep migrating other tenants after one fails
  --lock-timeout 5s        Postgres lock_timeout per tenant
  --statement-timeout 60s  Postgres statement_timeout per tenant
  --strict                 Fail a tenant if an applied migration file changed
  --dry-run                Print the SQL each tenant would run; change nothing
  --json                   Machine-readable output
  -h, --help               Show this help
`;

async function loadDriver(url: string): Promise<{ source: ConnectionSource; close: () => Promise<void> }> {
  try {
    const pg = (await import("pg")).default;
    const pool = new pg.Pool({ connectionString: url, max: 20 });
    return { source: toConnectionSource(pool), close: () => pool.end() };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ERR_MODULE_NOT_FOUND") throw err;
  }
  try {
    const postgres = (await import("postgres")).default;
    const sql = postgres(url, { max: 20, onnotice: () => {} });
    return { source: toConnectionSource(sql), close: () => sql.end() };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ERR_MODULE_NOT_FOUND") throw err;
  }
  throw new Error("Install a Postgres driver: `npm i pg` or `npm i postgres`.");
}

function fail(msg: string): never {
  process.stderr.write(`error: ${msg}\n\n`);
  process.exit(2);
}

function line(r: TenantResult): string {
  const ms = `${r.durationMs}ms`;
  const warn = r.changed.length ? `  (changed since applied: ${r.changed.join(", ")})` : "";
  switch (r.status) {
    case "migrated":
      return `✓ ${r.schema}  applied ${r.applied.length}: ${r.applied.join(", ")}  ${ms}${warn}`;
    case "up-to-date":
      return `· ${r.schema}  up to date  ${ms}${warn}`;
    case "skipped":
      return `- ${r.schema}  skipped (an earlier tenant failed)`;
    case "dry-run":
      return r.applied.length ? `? ${r.schema}  would apply ${r.applied.join(", ")}${warn}` : `· ${r.schema}  up to date${warn}`;
    case "failed":
      return `✗ ${r.schema}  FAILED  ${r.error?.message ?? ""}`;
  }
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      url: { type: "string" },
      dir: { type: "string", default: "./drizzle/tenant" },
      template: { type: "string", default: "tenant" },
      table: { type: "string" },
      tenants: { type: "string" },
      "tenants-query": { type: "string" },
      "tenants-file": { type: "string" },
      concurrency: { type: "string", default: "1" },
      "continue-on-error": { type: "boolean", default: false },
      "lock-timeout": { type: "string" },
      "statement-timeout": { type: "string" },
      strict: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  const command = positionals[0];
  if (values.help || !command) {
    process.stdout.write(HELP);
    process.exit(command || values.help ? 0 : 2);
  }
  if (command !== "migrate" && command !== "status") fail(`unknown command "${command}"\n\n${HELP}`);

  const url = values.url ?? process.env.DATABASE_URL;
  if (!url) fail("no database URL: pass --url or set DATABASE_URL");

  const sources = [values.tenants, values["tenants-query"], values["tenants-file"]].filter(Boolean);
  if (sources.length !== 1) fail("pass exactly one of --tenants, --tenants-query, --tenants-file");

  const concurrency = Number(values.concurrency);
  if (!Number.isInteger(concurrency) || concurrency < 1) fail("--concurrency must be a positive integer");

  const { source, close } = await loadDriver(url);

  const tenants = async (): Promise<string[]> => {
    if (values.tenants) return values.tenants.split(",").map((s) => s.trim()).filter(Boolean);
    if (values["tenants-file"]) {
      return readFileSync(values["tenants-file"], "utf8")
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => s && !s.startsWith("#"));
    }
    const conn = await source.connect();
    try {
      const { rows } = await conn.query<Record<string, unknown>>(values["tenants-query"]!);
      return rows.map((row) => String(Object.values(row)[0]));
    } finally {
      await conn.release();
    }
  };

  const common = {
    db: source,
    migrationsFolder: values.dir!,
    templateSchema: values.template!,
    migrationsTable: values.table,
    tenants,
  };

  try {
    if (command === "status") {
      const rows = await tenantStatus(common);
      if (values.json) {
        process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
      } else {
        for (const r of rows) {
          const state = !r.exists ? "missing" : r.pending.length ? `${r.pending.length} pending: ${r.pending.join(", ")}` : "up to date";
          const warn = r.changed.length ? `  (changed since applied: ${r.changed.join(", ")})` : "";
          process.stdout.write(`${r.schema}  ${r.applied.length} applied, ${state}${warn}\n`);
        }
        const behind = rows.filter((r) => r.pending.length > 0).length;
        process.stdout.write(`\n${rows.length} tenants, ${behind} behind\n`);
      }
      process.exitCode = 0;
      return;
    }

    const result = await migrateTenants({
      ...common,
      concurrency,
      continueOnError: values["continue-on-error"],
      dryRun: values["dry-run"],
      lockTimeout: values["lock-timeout"],
      statementTimeout: values["statement-timeout"],
      onChangedMigration: values.strict ? "error" : "warn",
      onTenant: values.json ? undefined : (r) => process.stdout.write(`${line(r)}\n`),
    });

    if (values.json) {
      const out = result.tenants.map((t) => ({ ...t, error: t.error?.message }));
      process.stdout.write(`${JSON.stringify({ ok: result.ok, tenants: out }, null, 2)}\n`);
    } else {
      if (values["dry-run"]) {
        for (const t of result.tenants) {
          for (const m of t.sql ?? []) {
            process.stdout.write(`\n-- ${t.schema} / ${m.migration}\n${m.statements.map((s) => (s.endsWith(";") ? s : `${s};`)).join("\n\n")}\n`);
          }
        }
      }
      const count = (s: string) => result.tenants.filter((t) => t.status === s).length;
      process.stdout.write(
        `\n${result.tenants.length} tenants: ${count("migrated")} migrated, ${count("up-to-date")} up to date, ${count("failed")} failed, ${count("skipped")} skipped\n`,
      );
    }
    process.exitCode = result.ok ? 0 : 1;
  } finally {
    await close();
  }
}

main().catch((err) => {
  process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
