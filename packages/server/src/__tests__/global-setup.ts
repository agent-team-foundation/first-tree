import { PostgreSqlContainer } from "@testcontainers/postgresql";

let container: Awaited<ReturnType<PostgreSqlContainer["start"]>> | undefined;

export async function setup() {
  // Allow using an external DB (e.g. docker-compose PG) by setting DATABASE_URL before running tests
  const externalUrl = process.env.DATABASE_URL;
  if (externalUrl) {
    process.env.JWT_SECRET_KEY = "test-jwt-secret-key-for-vitest";
    // Run migrations against the external DB
    const { execSync } = await import("node:child_process");
    execSync("pnpm db:migrate", {
      cwd: `${import.meta.dirname}/../..`,
      env: { ...process.env, DATABASE_URL: externalUrl },
      stdio: "pipe",
    });
    return;
  }

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
