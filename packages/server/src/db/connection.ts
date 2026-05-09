import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index.js";

export function connectDatabase(url: string) {
  const client = postgres(url, {
    ssl: { rejectUnauthorized: false },
  });
  const db = drizzle(client, { schema });
  return Object.assign(db, { end: () => client.end() });
}

export type Database = ReturnType<typeof connectDatabase>;
