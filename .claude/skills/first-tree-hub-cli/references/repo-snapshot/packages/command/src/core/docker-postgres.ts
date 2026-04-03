import { execFileSync, execSync } from "node:child_process";
import { randomBytes } from "node:crypto";

const CONTAINER_NAME = "first-tree-hub-postgres";
const PG_IMAGE = "postgres:16-alpine";
const PG_DB = "firsttreehub";
const PG_USER = "firsttreehub";

type DockerPgResult = {
  url: string;
  password: string;
  port: number;
  containerCreated: boolean;
};

/** Check if Docker is available. */
export function isDockerAvailable(): boolean {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Get the state of the first-tree-hub-postgres container. */
function getContainerState(): "running" | "stopped" | "none" {
  try {
    const output = execFileSync("docker", ["inspect", "--format", "{{.State.Running}}", CONTAINER_NAME], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return output === "true" ? "running" : "stopped";
  } catch {
    return "none";
  }
}

/** Get the host port mapped to container port 5432. */
function getMappedPort(): number {
  const output = execFileSync("docker", ["port", CONTAINER_NAME, "5432/tcp"], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  // Output: "0.0.0.0:5432" or "127.0.0.1:5432"
  const port = output.split(":").pop();
  return port ? Number(port) : 5432;
}

/** Find a free port starting from the given port. */
function findFreePort(start: number): number {
  for (let port = start; port < start + 100; port++) {
    try {
      execSync(`ss -tlnp | grep -q ':${port} '`, { stdio: "ignore" });
      // Port is in use, try next
    } catch {
      // Port is free
      return port;
    }
  }
  return start;
}

/**
 * Ensure a PostgreSQL container is running.
 * - If container exists and is running → reuse
 * - If container exists but stopped → restart
 * - If no container → create new one
 */
export function ensurePostgres(password: string | undefined): DockerPgResult {
  const state = getContainerState();

  if (state === "running") {
    const port = getMappedPort();
    const pw = getContainerPassword();
    return {
      url: `postgresql://${PG_USER}:${pw}@127.0.0.1:${port}/${PG_DB}`,
      password: pw,
      port,
      containerCreated: false,
    };
  }

  if (state === "stopped") {
    execFileSync("docker", ["start", CONTAINER_NAME], { stdio: "ignore" });
    waitForHealthy();
    const port = getMappedPort();
    const pw = getContainerPassword();
    return {
      url: `postgresql://${PG_USER}:${pw}@127.0.0.1:${port}/${PG_DB}`,
      password: pw,
      port,
      containerCreated: false,
    };
  }

  // Create new container
  const pw = password ?? randomBytes(24).toString("base64url");
  const port = findFreePort(5432);

  execFileSync(
    "docker",
    [
      "run",
      "-d",
      "--name",
      CONTAINER_NAME,
      "-e",
      `POSTGRES_DB=${PG_DB}`,
      "-e",
      `POSTGRES_USER=${PG_USER}`,
      "-e",
      `POSTGRES_PASSWORD=${pw}`,
      "-p",
      `127.0.0.1:${port}:5432`,
      "-v",
      "first-tree-hub-pgdata:/var/lib/postgresql/data",
      "--health-cmd",
      `pg_isready -U ${PG_USER}`,
      "--health-interval",
      "2s",
      "--health-timeout",
      "3s",
      "--health-retries",
      "10",
      "--restart",
      "unless-stopped",
      PG_IMAGE,
    ],
    { stdio: "ignore" },
  );

  waitForHealthy();

  return {
    url: `postgresql://${PG_USER}:${pw}@127.0.0.1:${port}/${PG_DB}`,
    password: pw,
    port,
    containerCreated: true,
  };
}

/** Stop and remove the managed PostgreSQL container. */
export function stopPostgres(): boolean {
  const state = getContainerState();
  if (state === "none") return false;
  execFileSync("docker", ["stop", CONTAINER_NAME], { stdio: "ignore" });
  return true;
}

/** Wait for the container health check to pass. */
function waitForHealthy(): void {
  const maxAttempts = 30;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const output = execFileSync("docker", ["inspect", "--format", "{{.State.Health.Status}}", CONTAINER_NAME], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (output === "healthy") return;
    } catch {
      // Container not ready yet
    }
    execFileSync("sleep", ["1"]);
  }
  throw new Error("PostgreSQL container did not become healthy within 60 seconds");
}

/** Extract the password from the container environment. */
function getContainerPassword(): string {
  const output = execFileSync(
    "docker",
    ["inspect", "--format", "{{range .Config.Env}}{{println .}}{{end}}", CONTAINER_NAME],
    { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
  );
  for (const line of output.split("\n")) {
    if (line.startsWith("POSTGRES_PASSWORD=")) {
      return line.slice("POSTGRES_PASSWORD=".length);
    }
  }
  throw new Error("Cannot determine PostgreSQL password from container");
}
