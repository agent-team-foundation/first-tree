import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index.js";

export function connectDatabase(url: string) {
  const client = postgres(url, sslOptions(url));
  const db = drizzle(client, { schema });
  return Object.assign(db, { end: () => client.end() });
}

// AWS RDS / Aurora enforces rds.force_ssl=1 and serves a cert that isn't in
// Node's default CA bundle — skip verification for RDS hosts only. Everything
// else (testcontainers, local Docker, self-host) stays on the no-SSL default.
export function sslOptions(url: string) {
  try {
    if (new URL(url).hostname.endsWith(".rds.amazonaws.com")) {
      return { ssl: { rejectUnauthorized: false } };
    }
  } catch {
    // Not a parseable URL — let postgres-js report the error.
  }
  return {};
}

export type Database = ReturnType<typeof connectDatabase>;
