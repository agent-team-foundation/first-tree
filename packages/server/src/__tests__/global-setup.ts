import { PostgreSqlContainer } from "@testcontainers/postgresql";

let container: Awaited<ReturnType<PostgreSqlContainer["start"]>>;

export async function setup() {
  container = await new PostgreSqlContainer("postgres:17").start();

  const url = container.getConnectionUri();
  process.env.DATABASE_URL = url;
  process.env.JWT_SECRET_KEY = "test-jwt-secret-key-for-vitest";

  // Run migrations via drizzle-kit
  const { execSync } = await import("node:child_process");
  execSync("pnpm db:migrate", {
    cwd: `${import.meta.dirname}/../..`,
    env: { ...process.env, DATABASE_URL: url },
    stdio: "pipe",
  });
}

export async function teardown() {
  await container?.stop();
}
