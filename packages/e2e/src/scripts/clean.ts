import { readdirSync, rmSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { bestEffortCleanupStaleContainers } from "../framework/docker-pg.js";
import { runDoctor } from "../framework/doctor.js";
import { PACKAGE_E2E_ROOT } from "../framework/env.js";

const RUNS_DIR = resolve(PACKAGE_E2E_ROOT, ".e2e-runs");
const KEEP_LAST = 20;
const MAX_AGE_DAYS = 7;

function pruneLocalRuns(): void {
  let entries: string[];
  try {
    entries = readdirSync(RUNS_DIR);
  } catch {
    return;
  }
  const now = Date.now();
  const ageCutoff = now - MAX_AGE_DAYS * 24 * 3600 * 1000;
  const runDirs = entries
    .filter((e) => e.startsWith("e2e-"))
    .map((name) => {
      const full = resolve(RUNS_DIR, name);
      const stat = statSync(full);
      return { name, full, mtime: stat.mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
  for (let i = 0; i < runDirs.length; i++) {
    const r = runDirs[i];
    if (!r) continue;
    const tooOld = r.mtime < ageCutoff;
    const overLimit = i >= KEEP_LAST;
    if (tooOld || overLimit) {
      rmSync(r.full, { recursive: true, force: true });
      console.log(`  pruned ${r.name}${tooOld ? " (age)" : ""}${overLimit ? " (over limit)" : ""}`);
    }
  }
}

function main(): void {
  const doctor = runDoctor(resolve(PACKAGE_E2E_ROOT, "..", ".."));
  if (doctor.dockerComposeBin) {
    console.log(`Cleaning stale e2e compose projects…`);
    bestEffortCleanupStaleContainers(doctor.dockerComposeBin);
  } else {
    console.warn("docker compose not available — skipping container cleanup");
  }
  console.log(`Pruning local run logs (keep ${KEEP_LAST} or ${MAX_AGE_DAYS}d)…`);
  pruneLocalRuns();
  console.log("done.");
}

main();
