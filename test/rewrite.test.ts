import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { readMigrations } from "../src/migrations.ts";
import { rewriteForTenant, rewriteStatement } from "../src/rewrite.ts";

const fixtures = join(import.meta.dirname, "fixtures");

test("rewrites qualified references, leaves strings and comments alone", () => {
  const sql = `-- touches "tenant".x
CREATE TABLE "tenant"."orders" ("note" text DEFAULT '"tenant".x', "tenant" int);
/* "tenant".y */ ALTER TABLE "tenant"."orders" ADD CONSTRAINT fk FOREIGN KEY ("c") REFERENCES "tenant"."customers"("id")`;
  const out = rewriteStatement(sql, "tenant", "t_acme");
  assert.equal(
    out,
    `-- touches "tenant".x
CREATE TABLE "t_acme"."orders" ("note" text DEFAULT '"tenant".x', "tenant" int);
/* "tenant".y */ ALTER TABLE "t_acme"."orders" ADD CONSTRAINT fk FOREIGN KEY ("c") REFERENCES "t_acme"."customers"("id")`,
  );
});

test("does not touch other schemas or similar names", () => {
  const sql = `SELECT * FROM "public"."tenant" JOIN "tenants"."x" ON true JOIN "my""tenant".z ON true`;
  assert.equal(rewriteStatement(sql, "tenant", "t1"), sql);
});

test("rewrites enum casts and dollar-quoted bodies", () => {
  const sql = `DEFAULT 'new'::"tenant"."order_status"; CREATE FUNCTION f() RETURNS int AS $$ SELECT count(*) FROM "tenant"."orders" $$ LANGUAGE sql`;
  assert.equal(
    rewriteStatement(sql, "tenant", "t1"),
    `DEFAULT 'new'::"t1"."order_status"; CREATE FUNCTION f() RETURNS int AS $$ SELECT count(*) FROM "t1"."orders" $$ LANGUAGE sql`,
  );
});

test("handles escaped quotes in strings", () => {
  const sql = `COMMENT ON TABLE "tenant"."a" IS 'it''s "tenant".a'; SELECT E'\\' "tenant".b'`;
  assert.equal(
    rewriteStatement(sql, "tenant", "x"),
    `COMMENT ON TABLE "x"."a" IS 'it''s "tenant".a'; SELECT E'\\' "tenant".b'`,
  );
});

test("drops drizzle-kit's CREATE SCHEMA for the template", () => {
  const out = rewriteForTenant(
    ['CREATE SCHEMA "tenant";', 'CREATE SCHEMA IF NOT EXISTS "tenant"', 'CREATE SCHEMA "audit";', 'CREATE TABLE "tenant"."a" (id int)'],
    "tenant",
    "t1",
  );
  assert.deepEqual(out, ['CREATE SCHEMA "audit";', 'CREATE TABLE "t1"."a" (id int)']);
});

test("reads drizzle-kit 0.x and 1.x folders the same way", () => {
  const v0 = readMigrations(join(fixtures, "kit-0x"));
  const v1 = readMigrations(join(fixtures, "kit-1x"));
  assert.deepEqual(v0.map((m) => m.name), ["0000_init", "0001_add_email"]);
  assert.deepEqual(v1.map((m) => m.name), ["20261124115643_init", "20261124115953_add_email"]);
  assert.equal(v0[0]!.statements[0], 'CREATE SCHEMA "tenant";');
  assert.equal(v1[1]!.createdAt, Date.UTC(2026, 10, 24, 11, 59, 53));
  for (const m of [...v0, ...v1]) assert.match(m.hash, /^[0-9a-f]{64}$/);
});
