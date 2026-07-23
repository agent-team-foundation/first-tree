import { execSync } from "node:child_process";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import postgres from "postgres";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { MAX_FORKS, TEMPLATE_DB, WORKER_BUCKET_PREFIX, WORKER_DB_PREFIX } from "./test-config.js";

let container: Awaited<ReturnType<PostgreSqlContainer["start"]>> | undefined;
let minioContainer: StartedTestContainer | undefined;

export async function setup() {
  // CI fast path: a sidecar Postgres is already running (GitHub Actions
  // `services:`), URL injected via env. Skip the testcontainers spin-up — on
  // ubuntu-latest runners the image pull + container start costs 10-25s on
  // the test critical path. Locally `CI_DATABASE_URL` is unset and we fall
  // back to testcontainers as before.
  const ciUrl = process.env.CI_DATABASE_URL;
  let baseUrl: string;
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

  await setupS3();
}

/**
 * Attachment S3 backend for the whole run. Mirrors the Postgres pattern:
 * CI injects a ready MinIO via `CI_S3_*` (fast path); locally we start a
 * `minio/minio` testcontainer. Either way we pre-create one bucket per
 * worker (`attachments-w1..wN`, see setup.ts) so file-parallel tests never
 * share objects, and hand the connection details to workers via env.
 */
async function setupS3() {
  const ciEndpoint = process.env.CI_S3_ENDPOINT;
  let endpoint: string;
  let region: string;
  let accessKeyId: string;
  let secretAccessKey: string;

  if (ciEndpoint) {
    endpoint = ciEndpoint;
    region = process.env.CI_S3_REGION ?? "us-east-1";
    accessKeyId = process.env.CI_S3_ACCESS_KEY_ID ?? "";
    secretAccessKey = process.env.CI_S3_SECRET_ACCESS_KEY ?? "";
    if (!accessKeyId || !secretAccessKey) {
      throw new Error("CI_S3_ENDPOINT is set but CI_S3_ACCESS_KEY_ID / CI_S3_SECRET_ACCESS_KEY are missing");
    }
  } else {
    const rootCredential = "minioadmin";
    minioContainer = await new GenericContainer("minio/minio:RELEASE.2025-09-07T16-13-09Z")
      .withCommand(["server", "/data"])
      .withEnvironment({ MINIO_ROOT_USER: rootCredential, MINIO_ROOT_PASSWORD: rootCredential })
      .withExposedPorts(9000)
      .withWaitStrategy(Wait.forHttp("/minio/health/live", 9000).forStatusCode(200))
      .start();
    endpoint = `http://${minioContainer.getHost()}:${minioContainer.getMappedPort(9000)}`;
    region = "us-east-1";
    accessKeyId = rootCredential;
    secretAccessKey = rootCredential;
  }

  // Pre-create one bucket per potential worker (same pattern as the
  // per-worker DB clones above). Already-existing buckets are fine —
  // reruns and CI's own mc-init both produce them.
  const s3 = new S3Client({
    region,
    endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });
  try {
    for (let i = 1; i <= MAX_FORKS; i++) {
      try {
        await s3.send(new CreateBucketCommand({ Bucket: `${WORKER_BUCKET_PREFIX}${i}` }));
      } catch (err) {
        const name = (err as { name?: unknown } | null)?.name;
        if (name !== "BucketAlreadyOwnedByYou" && name !== "BucketAlreadyExists") throw err;
      }
    }
  } finally {
    s3.destroy();
  }

  process.env.VITEST_S3_ENDPOINT = endpoint;
  process.env.VITEST_S3_REGION = region;
  process.env.VITEST_S3_ACCESS_KEY_ID = accessKeyId;
  process.env.VITEST_S3_SECRET_ACCESS_KEY = secretAccessKey;
}

export async function teardown() {
  await minioContainer?.stop();
  await container?.stop();
}
