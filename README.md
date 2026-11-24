# drizzle-tenant-migrate

Run your Drizzle migrations in every tenant schema in Postgres.

Drizzle handles one schema well. If you give each customer their own Postgres schema (`t_acme`, `t_bistro`, …), you need to run the same migrations in each of them, track which ones ran where, and not leave a tenant half-migrated when something fails. drizzle-kit doesn't do this. This package does, and nothing more.

- Uses the SQL that `drizzle-kit generate` already writes. Supports both the 0.x layout (`meta/_journal.json`) and the 1.x layout (`<timestamp>_<name>/migration.sql`).
- Each tenant gets its own transaction. A failure rolls that tenant back fully. By default, no other tenants start after a failure.
- Each tenant has its own tracking table at `<tenant>.__drizzle_migrations`, so you can see exactly where each one stands.
- A Postgres advisory lock per tenant makes it safe for two deploys to run at once.
- Parallel runs (`--concurrency`), `status`, `--dry-run`, and warnings when someone edits a migration after it ran.
- Works with `pg`, `postgres` (postgres.js) and Bun's `SQL`. No other runtime dependencies.

## Install

```bash
npm i -D drizzle-tenant-migrate
```

You also need `pg` or `postgres` installed. You probably have one already.

## Setup

### 1. Define tenant tables in one factory

Put the per-tenant tables in a function that takes the schema name. drizzle-kit reads the `"tenant"` copy. Your app calls the function with the real tenant schema.

```ts
// src/db/tenant-schema.ts
import { pgSchema, serial, text, integer } from "drizzle-orm/pg-core";

export function tenantTables(name: string) {
  const schema = pgSchema(name);
  const customers = schema.table("customers", {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
  });
  const orders = schema.table("orders", {
    id: serial("id").primaryKey(),
    customerId: integer("customer_id").references(() => customers.id),
  });
  return { schema, customers, orders };
}

// drizzle-kit generates migrations from this copy
export const { schema: tenant, customers, orders } = tenantTables("tenant");
```

Shared tables (the tenant list, billing, users) stay in `public` with their own drizzle-kit config and the usual `drizzle-kit migrate`.

### 2. Give tenant tables their own drizzle-kit config

```ts
// drizzle.tenant.config.ts
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/tenant-schema.ts",
  out: "./drizzle/tenant",
  schemaFilter: ["tenant"],
});
```

```bash
npx drizzle-kit generate --config drizzle.tenant.config.ts
```

The SQL refers to `"tenant"."orders"`, `"tenant"."order_status"` and so on. When it runs for a tenant, every `"tenant".` becomes `"t_acme".` (or that tenant's schema). Text inside string literals and comments is left alone. The `"tenant"` schema itself is never created.

### 3. Run it

```bash
export DATABASE_URL=postgres://…

npx drizzle-tenant-migrate status  --tenants-query "select schema_name from public.tenants"
npx drizzle-tenant-migrate migrate --tenants-query "select schema_name from public.tenants" --concurrency 4
```

```
✓ t_acme    applied 2: 0000_init, 0001_add_email  19ms
✓ t_bistro  applied 2: 0000_init, 0001_add_email  21ms
· t_cafe    up to date  4ms

3 tenants: 2 migrated, 1 up to date, 0 failed, 0 skipped
```

The command exits with 1 if any tenant fails, so it can gate a deploy.

### 4. Query a tenant at runtime

```ts
const t = tenantTables(tenantSchemaFor(req)); // cache this per schema name
await db.select().from(t.orders);
```

## New tenant at sign-up

```ts
import { migrateTenant } from "drizzle-tenant-migrate";

await migrateTenant("t_newco", { db: pool, migrationsFolder: "./drizzle/tenant" });
```

This creates the schema and brings it up to date in one transaction. If it fails, it throws and leaves nothing behind.

## API

```ts
import { migrateTenants, migrateTenant, tenantStatus } from "drizzle-tenant-migrate";

const result = await migrateTenants({
  db: pool,                       // pg.Pool, postgres.js sql, Bun SQL, or { connect() }
  migrationsFolder: "./drizzle/tenant",
  tenants: async () => (await pool.query("select schema_name from public.tenants")).rows.map((r) => r.schema_name),
  templateSchema: "tenant",       // default
  concurrency: 4,                 // default 1
  continueOnError: false,         // default: stop starting new tenants after a failure
  lockTimeout: "5s",              // optional, per tenant
  statementTimeout: "60s",        // optional, per tenant
  onChangedMigration: "warn",     // or "error"
  onTenant: (r) => console.log(r.schema, r.status),
});

result.ok;       // false if any tenant failed
result.tenants;  // [{ schema, status, applied, changed, error?, durationMs }]
```

`tenantStatus()` takes the same options and returns `{ schema, exists, applied, pending, changed }` for each tenant without changing anything.

## CLI options

| Option | Default | |
|---|---|---|
| `--tenants a,b,c` / `--tenants-query "SQL"` / `--tenants-file path` | | Where the tenant list comes from. Pass exactly one. |
| `--url` | `$DATABASE_URL` | |
| `--dir` | `./drizzle/tenant` | drizzle-kit output folder |
| `--template` | `tenant` | Schema name used in `pgSchema()` |
| `--table` | `__drizzle_migrations` | Tracking table in each schema |
| `--concurrency` | `1` | Tenants migrated in parallel, one connection each |
| `--continue-on-error` | off | Keep going after a tenant fails |
| `--lock-timeout`, `--statement-timeout` | server default | Set per tenant transaction |
| `--strict` | off | Fail a tenant if an applied migration file was edited |
| `--dry-run` | off | Print each tenant's SQL. Change nothing. |
| `--json` | off | Machine-readable output |

## How it decides what to run

A migration counts as applied in a tenant if its name is in that tenant's tracking table. Rows that drizzle-orm's own migrator wrote have no name, so those match by file hash instead. This means you can adopt schemas you used to migrate with a hand-rolled `search_path` loop. If an applied migration's file has changed since it ran, it is reported as `changed` (or fails the tenant with `--strict`). It is never re-run.

While a tenant migrates, `search_path` is set to `<tenant>, public`, so hand-written SQL that leaves out the schema still lands in the tenant.

## Limits

- Postgres only.
- The template name must appear as a quoted identifier (`"tenant".`), which is how drizzle-kit writes it. Pick a name that your shared schemas don't use.
- Migrations run inside a transaction, so `CREATE INDEX CONCURRENTLY` can't be used in tenant migrations.
- Use a different schema name for tenants (`t_acme`) than for the template. A schema named `tenant` is only a placeholder.

## Development

```bash
docker run -d --rm -e POSTGRES_PASSWORD=postgres -p 55432:5432 postgres:17-alpine
DATABASE_URL=postgres://postgres:postgres@localhost:55432/postgres npm test
```

## License

MIT
