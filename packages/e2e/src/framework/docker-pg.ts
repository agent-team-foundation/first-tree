import { execFileSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { PACKAGE_E2E_ROOT } from "./env.js";
import type { RunIdentity } from "./isolation.js";

const COMPOSE_FILE = resolve(PACKAGE_E2E_ROOT, "scripts", "compose.e2e.yml");

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
  composeBin: string;
  /** docker compose readiness poll. Defaults to 60s. */
  waitMs?: number;
};

/**
 * Start the e2e PostgreSQL via docker compose, wait until pg_isready, return
 * the connection string the server should use.
 */
export async function startDockerPg(opts: DockerPgOptions): Promise<PgProcess> {
  const { cmd, preArgs } = splitComposeBin(opts.composeBin);
  const env = {
    ...process.env,
    E2E_PG_IMAGE: opts.pgImage,
    E2E_PG_PORT: String(opts.port),
    E2E_RUN_SHORT_ID: opts.identity.shortId,
    COMPOSE_PROJECT_NAME: opts.identity.composeProject,
  } satisfies NodeJS.ProcessEnv;

  const upArgs = [...preArgs, "-f", COMPOSE_FILE, "-p", opts.identity.composeProject, "up", "-d", "--wait"];
  const waitMs = opts.waitMs ?? 60_000;
  const up = spawnSync(cmd, upArgs, { env, encoding: "utf8", timeout: waitMs });
  if (up.status !== 0) {
    throw new Error(`docker compose up failed (status=${up.status}):\nstdout:\n${up.stdout}\nstderr:\n${up.stderr}`);
  }

  const databaseUrl = `postgres://firsttreehub_e2e:firsttreehub_e2e@127.0.0.1:${opts.port}/firsttreehub_e2e`;

  const stop = async (): Promise<void> => {
    const downArgs = [
      ...preArgs,
      "-f",
      COMPOSE_FILE,
      "-p",
      opts.identity.composeProject,
      "down",
      "-v",
      "--remove-orphans",
    ];
    const down = spawnSync(cmd, downArgs, { env, encoding: "utf8", timeout: 30_000 });
    if (down.status !== 0) {
      console.warn(
        `docker compose down (project=${opts.identity.composeProject}) exited ${down.status}: ${down.stderr}`,
      );
    }
  };

  return { port: opts.port, databaseUrl, stop };
}

/**
 * Best-effort cleanup of leftover compose projects from crashed runs.
 * Matches both `hub_e2e_*` (current naming) and stale `hub-e2e-*` (in case the
 * project name lossy-shifted).
 */
export function bestEffortCleanupStaleContainers(composeBin: string): void {
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
}
