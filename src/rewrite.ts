/** Quotes a Postgres identifier. */
export function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/**
 * Rejects schema names that Postgres would truncate or that are clearly not
 * meant as tenant schemas. Quoting already makes any name injection-safe;
 * this only catches mistakes early.
 */
export function assertSchemaName(name: string): void {
  if (typeof name !== "string" || name.length === 0) {
    throw new Error("Tenant schema name must be a non-empty string");
  }
  if (Buffer.byteLength(name, "utf8") > 63) {
    throw new Error(`Schema name "${name}" is longer than 63 bytes; Postgres would truncate it`);
  }
  if (name.startsWith("pg_") || name === "information_schema") {
    throw new Error(`"${name}" is a reserved Postgres schema name`);
  }
}

/** Matches `CREATE SCHEMA "tenant";` as drizzle-kit emits it. The runner creates the schema itself. */
function isCreateTemplateSchema(stmt: string, template: string): boolean {
  const re = new RegExp(
    `^CREATE\\s+SCHEMA\\s+(IF\\s+NOT\\s+EXISTS\\s+)?${escapeRe(quoteIdent(template))}\\s*;?$`,
    "i",
  );
  return re.test(stmt.trim());
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Replaces every schema-qualified reference to the template schema
 * (`"tenant".`) with the target schema. Single-quoted strings and comments
 * are left alone, so data and docs that mention the name are not touched.
 * Dollar-quoted bodies (functions, DO blocks) are rewritten, since they are
 * code that usually refers to the tenant's own tables.
 */
export function rewriteStatement(stmt: string, template: string, target: string): string {
  const from = `${quoteIdent(template)}.`;
  const to = `${quoteIdent(target)}.`;
  let out = "";
  let i = 0;
  const n = stmt.length;

  while (i < n) {
    const c = stmt[i];
    const next = stmt[i + 1];

    // -- line comment
    if (c === "-" && next === "-") {
      const end = stmt.indexOf("\n", i);
      const stop = end === -1 ? n : end;
      out += stmt.slice(i, stop);
      i = stop;
      continue;
    }

    // /* block comment */ (no nesting support needed for generated SQL)
    if (c === "/" && next === "*") {
      const end = stmt.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      out += stmt.slice(i, stop);
      i = stop;
      continue;
    }

    // 'string literal' with '' escapes (also covers E'...' since the E is copied as-is)
    if (c === "'") {
      let j = i + 1;
      while (j < n) {
        if (stmt[j] === "'" && stmt[j + 1] === "'") {
          j += 2;
          continue;
        }
        if (stmt[j] === "\\" && /[eE]/.test(stmt[i - 1] ?? "")) {
          j += 2;
          continue;
        }
        if (stmt[j] === "'") break;
        j++;
      }
      out += stmt.slice(i, j + 1);
      i = j + 1;
      continue;
    }

    if (stmt.startsWith(from, i)) {
      out += to;
      i += from.length;
      continue;
    }

    // Any other quoted identifier: copy whole so `"x""tenant".` can't false-match.
    if (c === '"') {
      let j = i + 1;
      while (j < n) {
        if (stmt[j] === '"' && stmt[j + 1] === '"') {
          j += 2;
          continue;
        }
        if (stmt[j] === '"') break;
        j++;
      }
      out += stmt.slice(i, j + 1);
      i = j + 1;
      continue;
    }

    out += c;
    i++;
  }

  return out;
}

/** Rewrites a migration's statements for one tenant, dropping drizzle-kit's `CREATE SCHEMA "<template>"`. */
export function rewriteForTenant(statements: string[], template: string, target: string): string[] {
  return statements
    .filter((s) => !isCreateTemplateSchema(s, template))
    .map((s) => rewriteStatement(s, template, target));
}
