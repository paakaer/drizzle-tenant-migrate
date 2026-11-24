/** One reserved connection. Every call on it runs on the same backend session. */
export interface Connection {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
  release(): void | Promise<void>;
}

/** Something that hands out connections. A `pg.Pool` already satisfies this. */
export interface ConnectionSource {
  connect(): Promise<Connection>;
}

interface PostgresJsReserved {
  unsafe(text: string, params?: unknown[]): Promise<unknown>;
  release(): void;
}

interface PostgresJsLike {
  reserve(): Promise<PostgresJsReserved>;
}

/**
 * Adapter for postgres.js (`postgres`) and Bun's built-in `SQL`, both of
 * which expose `reserve()` and `unsafe()`.
 */
export function fromPostgresJs(sql: PostgresJsLike): ConnectionSource {
  return {
    async connect() {
      const conn = await sql.reserve();
      return {
        async query<T>(text: string, params?: unknown[]) {
          const rows = (await conn.unsafe(text, params ?? [])) as T[];
          return { rows: Array.from(rows) };
        },
        release: () => conn.release(),
      };
    },
  };
}

/** Accepts a pg.Pool, anything with `connect()`, or a postgres.js / Bun SQL instance. */
export function toConnectionSource(db: unknown): ConnectionSource {
  const d = db as Record<string, unknown>;
  if (d && typeof d.reserve === "function" && typeof d.unsafe === "function") {
    return fromPostgresJs(db as PostgresJsLike);
  }
  if (d && typeof d.connect === "function") {
    return db as ConnectionSource;
  }
  throw new Error(
    "Unsupported database client. Pass a pg.Pool, a postgres.js / Bun SQL instance, or an object with connect().",
  );
}
