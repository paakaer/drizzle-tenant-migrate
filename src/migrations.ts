import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface Migration {
  /** Migration tag, e.g. `0003_add_orders` (drizzle-kit 0.x) or `20261124115643_init` (drizzle-kit 1.x). */
  name: string;
  /** sha256 of the raw SQL file, same as drizzle-orm computes. */
  hash: string;
  /** Timestamp from the journal (0.x) or the folder name (1.x). */
  createdAt: number;
  /** The statements, split on `--> statement-breakpoint`. Empty ones are dropped. */
  statements: string[];
}

const BREAKPOINT = "--> statement-breakpoint";

function parse(name: string, sql: string, createdAt: number): Migration {
  return {
    name,
    hash: createHash("sha256").update(sql).digest("hex"),
    createdAt,
    statements: sql
      .split(BREAKPOINT)
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  };
}

/** `20261124115643` -> UTC millis, same as drizzle-orm 1.x. */
function folderMillis(stamp: string): number {
  const n = (from: number, to: number) => Number.parseInt(stamp.slice(from, to), 10);
  return Date.UTC(n(0, 4), n(4, 6) - 1, n(6, 8), n(8, 10), n(10, 12), n(12, 14));
}

/**
 * Reads a drizzle-kit migrations folder. Supports both layouts:
 * - drizzle-kit 0.x: `meta/_journal.json` + `<tag>.sql`
 * - drizzle-kit 1.x: `<YYYYMMDDHHMMSS>_<name>/migration.sql`
 */
export function readMigrations(folder: string): Migration[] {
  if (!existsSync(folder)) {
    throw new Error(`Migrations folder not found: ${folder}`);
  }

  const journalPath = join(folder, "meta", "_journal.json");
  if (existsSync(journalPath)) {
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
      entries: { tag: string; when: number }[];
    };
    return journal.entries.map((entry) => {
      const file = join(folder, `${entry.tag}.sql`);
      if (!existsSync(file)) {
        throw new Error(`Journal lists ${entry.tag} but ${file} is missing`);
      }
      return parse(entry.tag, readFileSync(file, "utf8"), entry.when);
    });
  }

  const dirs = readdirSync(folder)
    .filter((d) => statSync(join(folder, d)).isDirectory())
    .filter((d) => existsSync(join(folder, d, "migration.sql")))
    .sort((a, b) => a.localeCompare(b));

  if (dirs.length === 0) {
    throw new Error(
      `No migrations in ${folder}. Expected meta/_journal.json (drizzle-kit 0.x) or <timestamp>_<name>/migration.sql folders (drizzle-kit 1.x).`,
    );
  }

  return dirs.map((d) =>
    parse(d, readFileSync(join(folder, d, "migration.sql"), "utf8"), folderMillis(d.slice(0, 14))),
  );
}
