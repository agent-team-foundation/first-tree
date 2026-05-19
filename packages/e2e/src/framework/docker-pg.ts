import { execFileSync, spawnSync } from "node:child_process";
import type { RunIdentity } from "./isolation.js";

export type PgProcess = {
  port: number;
  databaseUrl: string;
  stop: () => Promise<void>;
};

function splitComposeBin(bin: string): { cmd: string; preArgs: string[] } {
  const parts = bin.trim().split(/\s+/);
  const [cmd, ...preArgs] = parts;
  if (!cmd) throw new Error(`Empty docker compose binary spec: ${bin}`);
  return { cmd, preArgs };
}

export type DockerPgOptions = {
  identity: RunIdentity;
  port: number;
  pgImage: string;
  /** readiness poll budget. Defaults to 60s. */
  waitMs?: number;
};

/**
 * Start the e2e PostgreSQL via `docker run`.
 *
 * Was originally a `docker compose up`. Switched because Docker Desktop on
 * macOS (observed on docker engine 29.x) exhibits intermittent ECONNRESET
 * on port-forwarded TCP into compose-managed containers — both the default
 * user-defined bridge and an explicit `network_mode: bridge` reproduce; the
 * same image via plain `docker run` is stable. Compose was buying us four
 * features — ports, healthcheck, naming, tmpfs — and we now do all four
 * directly here. The `--tmpfs` flag matches the original compose intent:
 * each run starts from an empty cluster in memory, and crashed runs leave
 * nothing behind on disk.
 *
 * `bestEffortCleanupStaleContainers` keeps its compose-project sweep (so old
 * runs from before this switch still get cleaned up) and adds a parallel
 * sweep for the standalone containers this function now creates.
 */
export async function startDockerPg(opts: DockerPgOptions): Promise<PgProcess> {
  const containerName = `hub_e2e_${opts.identity.shortId}_pg`;
  const env: NodeJS.ProcessEnv = { ...process.env };

  // Remove any leftover container with this name (e.g. previous crashed run).
  spawnSync("docker", ["rm", "-f", containerName], { env, encoding: "utf8" });

  const runArgs = [
    "run",
    "-d",
    "--name",
    containerName,
    "-p",
    `${opts.port}:5432`,
    "-e",
    "POSTGRES_DB=firsttreehub_e2e",
    "-e",
    "POSTGRES_USER=firsttreehub_e2e",
    "-e",
    "POSTGRES_PASSWORD=firsttreehub_e2e",
    "--tmpfs",
    "/var/lib/postgresql/data:rw",
    "--health-cmd",
    "pg_isready -U firsttreehub_e2e -d firsttreehub_e2e",
    "--health-interval",
    "1s",
    "--health-timeout",
    "2s",
    "--health-retries",
    "30",
    "--health-start-period",
    "2s",
    opts.pgImage,
  ];
  const waitMs = opts.waitMs ?? 60_000;
  const run = spawnSync("docker", runArgs, { env, encoding: "utf8", timeout: waitMs });
  if (run.status !== 0) {
    throw new Error(`docker run pg failed (status=${run.status}):\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
  }

  // Poll healthcheck status until "healthy" or timeout, retaining the last
  // observed status so the error path can report what we saw last.
  const deadline = Date.now() + waitMs;
  let lastStatus = "";
  while (Date.now() < deadline) {
    const inspect = spawnSync("docker", ["inspect", "--format", "{{.State.Health.Status}}", containerName], {
      env,
      encoding: "utf8",
    });
    lastStatus = inspect.status === 0 ? inspect.stdout.trim() : `inspect-exit-${inspect.status}`;
    if (lastStatus === "healthy") break;
    await new Promise<void>((r) => setTimeout(r, 250));
  }
  if (lastStatus !== "healthy") {
    const logs = spawnSync("docker", ["logs", containerName], { env, encoding: "utf8" });
    spawnSync("docker", ["rm", "-f", containerName], { env, encoding: "utf8" });
    throw new Error(
      `pg container did not become healthy within ${waitMs}ms (last status=${lastStatus}):\n${logs.stdout}\n${logs.stderr}`,
    );
  }

  const databaseUrl = `postgres://firsttreehub_e2e:firsttreehub_e2e@127.0.0.1:${opts.port}/firsttreehub_e2e`;

  const stop = async (): Promise<void> => {
    const down = spawnSync("docker", ["rm", "-f", containerName], { env, encoding: "utf8", timeout: 30_000 });
    if (down.status !== 0) {
      console.warn(`docker rm -f ${containerName} exited ${down.status}: ${down.stderr}`);
    }
  };

  return { port: opts.port, databaseUrl, stop };
}

/**
 * Best-effort cleanup of leftovers from crashed runs. Two sweeps:
 *
 *   1. Compose projects matching `hub_e2e_*` / `hub-e2e-*` — legacy runs
 *      that pre-date the switch to `docker run`.
 *   2. Standalone containers matching `hub_e2e_*_pg` — the shape this
 *      module creates today; only matter if a previous run crashed before
 *      its `stop()` ran.
 *
 * Both sweeps swallow errors; doctor surfaces missing CLI tools separately.
 */
export function bestEffortCleanupStaleContainers(composeBin: string): void {
  // Sweep 1: legacy compose projects.
  try {
    const { cmd, preArgs } = splitComposeBin(composeBin);
    const out = execFileSync(cmd, [...preArgs, "ls", "--all", "--format", "json"], { encoding: "utf8" });
    const projects: Array<{ Name?: string }> = JSON.parse(out);
    for (const p of projects) {
      if (!p.Name) continue;
      if (!/^hub[_-]e2e[_-]/i.test(p.Name)) continue;
      try {
        execFileSync(cmd, [...preArgs, "-p", p.Name, "down", "-v", "--remove-orphans"], { stdio: "ignore" });
      } catch {
        // swallow: best effort
      }
    }
  } catch {
    // swallow: docker compose may not be installed yet; doctor will catch that
  }

  // Sweep 2: standalone containers created by current `startDockerPg`.
  // Single combined regex because `docker ps` ORs multiple --filter values
  // of the same key — passing `name=^hub_e2e_` AND `name=_pg$` separately
  // would also reap any unrelated container ending in `_pg`.
  try {
    const out = execFileSync("docker", ["ps", "-a", "--filter", "name=^hub_e2e_.*_pg$", "--format", "{{.Names}}"], {
      encoding: "utf8",
    });
    for (const name of out
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)) {
      try {
        execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" });
      } catch {
        // swallow: best effort
      }
    }
  } catch {
    // swallow: docker may not be installed yet; doctor will catch that
  }
}
