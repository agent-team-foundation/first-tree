import { execSync } from "node:child_process";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import postgres from "postgres";
import { MAX_FORKS, TEMPLATE_DB, WORKER_DB_PREFIX } from "./test-config.js";

let container: Awaited<ReturnType<PostgreSqlContainer["start"]>> | undefined;

export async function setup() {
  // Skip Ryuk reaper to avoid pulling testcontainers/ryuk:0.14.0 from docker.io
  // — many local Docker daemons sit behind flaky proxies, and Ryuk is only
  // needed to clean up containers when the test runner crashes; for local dev
  // and CI with explicit teardown, it is safe to disable.
  process.env.TESTCONTAINERS_RYUK_DISABLED ??= "true";
  container = await new PostgreSqlContainer("postgres:17").start();

  const baseUrl = container.getConnectionUri();
  process.env.JWT_SECRET_KEY = "test-jwt-secret-key-for-vitest";

  // Create a migrated template database. Each worker (see setup.ts) gets its
  // own pre-cloned DB so file-parallel test files can TRUNCATE independently.
  // Cloning via `CREATE DATABASE ... TEMPLATE` is a near-instant page-level
  // copy at the PG storage layer — far cheaper than re-running migrations
  // per worker.
  const adminUrl = new URL(baseUrl);
  adminUrl.pathname = "/postgres";
  const admin = postgres(adminUrl.toString(), { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${TEMPLATE_DB}`);
    await admin.unsafe(`CREATE DATABASE ${TEMPLATE_DB}`);

    const templateUrl = new URL(baseUrl);
    templateUrl.pathname = `/${TEMPLATE_DB}`;
    execSync("pnpm db:migrate", {
      cwd: `${import.meta.dirname}/../..`,
      env: { ...process.env, DATABASE_URL: templateUrl.toString() },
      stdio: "pipe",
    });

    // Pre-clone one DB per potential worker. Doing this serially in setup
    // keeps the per-worker hot path zero-IO (setup.ts just picks a URL).
    for (let i = 1; i <= MAX_FORKS; i++) {
      const dbName = `${WORKER_DB_PREFIX}${i}`;
      await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName}`);
      await admin.unsafe(`CREATE DATABASE ${dbName} TEMPLATE ${TEMPLATE_DB}`);
    }
  } finally {
    await admin.end();
  }

  // Hand-off to per-worker setup.ts via env (workers inherit parent env at
  // spawn under the `forks` pool).
  process.env.VITEST_PG_BASE_URL = baseUrl;
  process.env.VITEST_PG_MAX_WORKERS = String(MAX_FORKS);
  // Leave DATABASE_URL pointing at the template until setup.ts replaces it
  // per-worker; nothing reads DATABASE_URL between globalSetup and worker
  // bootstrap, so this is just a sane default if that ever changes.
  const templateUrl = new URL(baseUrl);
  templateUrl.pathname = `/${TEMPLATE_DB}`;
  process.env.DATABASE_URL = templateUrl.toString();
}

export async function teardown() {
  await container?.stop();
}
