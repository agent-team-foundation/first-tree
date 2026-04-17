import { PostgreSqlContainer } from "@testcontainers/postgresql";

let container: Awaited<ReturnType<PostgreSqlContainer["start"]>> | undefined;

export async function setup() {
  // Skip Ryuk reaper to avoid pulling testcontainers/ryuk:0.14.0 from docker.io
  // — many local Docker daemons sit behind flaky proxies, and Ryuk is only
  // needed to clean up containers when the test runner crashes; for local dev
  // and CI with explicit teardown, it is safe to disable.
  process.env.TESTCONTAINERS_RYUK_DISABLED ??= "true";
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
