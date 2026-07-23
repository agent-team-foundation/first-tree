import { execSync } from "node:child_process";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import postgres from "postgres";
import { GenericContainer, Wait } from "testcontainers";
import { MAX_FORKS, TEMPLATE_DB, WORKER_DB_PREFIX, WORKER_S3_BUCKET_PREFIX } from "./test-config.js";

let container: Awaited<ReturnType<PostgreSqlContainer["start"]>> | undefined;
let minioContainer: Awaited<ReturnType<GenericContainer["start"]>> | undefined;

/**
 * Pinned MinIO release so local and CI runs exercise the same S3 dialect.
 * Suites never require real cloud credentials — this container (or the
 * `CI_S3_ENDPOINT` escape hatch) is the only storage backend tests touch.
 */
const MINIO_IMAGE = "minio/minio:RELEASE.2025-04-22T22-12-26Z";
const MINIO_ROOT_USER = "vitest-minio";
const MINIO_ROOT_PASSWORD = "vitest-minio-secret";

async function startObjectStorage(): Promise<{ endpoint: string; accessKeyId: string; secretAccessKey: string }> {
  // Escape hatch mirroring CI_DATABASE_URL: point tests at an externally
  // provisioned S3-compatible server (e.g. a CI sidecar) instead of the
  // testcontainers-managed MinIO.
  const ciEndpoint = process.env.CI_S3_ENDPOINT;
  if (ciEndpoint) {
    return {
      endpoint: ciEndpoint,
      accessKeyId: process.env.CI_S3_ACCESS_KEY_ID ?? MINIO_ROOT_USER,
      secretAccessKey: process.env.CI_S3_SECRET_ACCESS_KEY ?? MINIO_ROOT_PASSWORD,
    };
  }
  minioContainer = await new GenericContainer(MINIO_IMAGE)
    .withEnvironment({ MINIO_ROOT_USER, MINIO_ROOT_PASSWORD })
    .withCommand(["server", "/data"])
    .withExposedPorts(9000)
    .withWaitStrategy(Wait.forHttp("/minio/health/ready", 9000))
    .start();
  return {
    endpoint: `http://${minioContainer.getHost()}:${minioContainer.getMappedPort(9000)}`,
    accessKeyId: MINIO_ROOT_USER,
    secretAccessKey: MINIO_ROOT_PASSWORD,
  };
}

export async function setup() {
  // CI fast path: a sidecar Postgres is already running (GitHub Actions
  // `services:`), URL injected via env. Skip the testcontainers spin-up — on
  // ubuntu-latest runners the image pull + container start costs 10-25s on
  // the test critical path. Locally `CI_DATABASE_URL` is unset and we fall
  // back to testcontainers as before.
  const ciUrl = process.env.CI_DATABASE_URL;
  let baseUrl: string;
  // MinIO starts concurrently with PG — neither depends on the other.
  const objectStoragePromise = startObjectStorage();
  if (ciUrl) {
    baseUrl = ciUrl;
  } else {
    container = await new PostgreSqlContainer("postgres:17").start();
    baseUrl = container.getConnectionUri();
  }
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

  // Per-worker buckets mirror the per-worker databases: file-parallel
  // workers write to disjoint buckets, and object keys are UUID-derived so
  // suites never collide within a worker either.
  const objectStorage = await objectStoragePromise;
  const s3 = new S3Client({
    region: "us-east-1",
    endpoint: objectStorage.endpoint,
    forcePathStyle: true,
    credentials: {
      accessKeyId: objectStorage.accessKeyId,
      secretAccessKey: objectStorage.secretAccessKey,
    },
  });
  try {
    for (let i = 1; i <= MAX_FORKS; i++) {
      try {
        await s3.send(new CreateBucketCommand({ Bucket: `${WORKER_S3_BUCKET_PREFIX}${i}` }));
      } catch (error) {
        // Re-runs against a live CI sidecar hit BucketAlreadyOwnedByYou.
        const name = typeof error === "object" && error !== null && "name" in error ? error.name : undefined;
        if (name !== "BucketAlreadyOwnedByYou" && name !== "BucketAlreadyExists") throw error;
      }
    }
  } finally {
    s3.destroy();
  }

  // Hand-off to per-worker setup.ts via env (workers inherit parent env at
  // spawn under the `forks` pool).
  process.env.VITEST_PG_BASE_URL = baseUrl;
  process.env.VITEST_PG_MAX_WORKERS = String(MAX_FORKS);
  process.env.VITEST_S3_ENDPOINT = objectStorage.endpoint;
  process.env.VITEST_S3_ACCESS_KEY_ID = objectStorage.accessKeyId;
  process.env.VITEST_S3_SECRET_ACCESS_KEY = objectStorage.secretAccessKey;
  // Leave DATABASE_URL pointing at the template until setup.ts replaces it
  // per-worker; nothing reads DATABASE_URL between globalSetup and worker
  // bootstrap, so this is just a sane default if that ever changes.
  const templateUrl = new URL(baseUrl);
  templateUrl.pathname = `/${TEMPLATE_DB}`;
  process.env.DATABASE_URL = templateUrl.toString();
}

export async function teardown() {
  await container?.stop();
  await minioContainer?.stop();
}
