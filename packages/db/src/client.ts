import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index.js";

export type Db = ReturnType<typeof createDb>["db"];
export type Sql = ReturnType<typeof postgres>;

export function createDb(
  url = process.env.DATABASE_URL ?? "postgres://voxi:voxi@localhost:5432/voxi",
  opts?: { max?: number },
) {
  const sql = postgres(url, { max: opts?.max ?? 10, onnotice: () => {} });
  const db = drizzle(sql, { schema });
  return { db, sql, close: () => sql.end({ timeout: 5 }) };
}

export { schema };
