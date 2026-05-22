import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

/**
 * A run's identity. Single string derives:
 *   - docker compose project (`hub_e2e_<runId>`)
 *   - PG container name
 *   - CLI home dir (`$TMPDIR/hub-e2e-<runId>`)
 *   - run-scoped log dir (`packages/e2e/.e2e-runs/<runId>/`)
 *
 * Two concurrent runs on the same machine never collide as long as `runId` is
 * unique. If a previous run crashed leaving stale docker resources, the
 * lifecycle layer does a best-effort cleanup before starting (see lifecycle.ts).
 */
export type RunIdentity = {
  runId: string;
  /** Short-token form, safe inside docker names + filesystem paths. */
  shortId: string;
  /** `$TMPDIR/hub-e2e-<shortId>` — passed to spawned CLI as FIRST_TREE_HOME. */
  home: string;
  /** Docker compose project name. Lowercase, underscored. */
  composeProject: string;
  /** `<repo>/packages/e2e/.e2e-runs/<runId>` — log archive root. */
  runDir: string;
};

export function makeRunIdentity(packageRoot: string, override?: string): RunIdentity {
  const shortId = (override ?? randomBytes(3).toString("hex")).replace(/[^a-z0-9]/gi, "").slice(0, 8) || "default";
  const runId = `e2e-${shortId}`;
  const home = resolve(tmpdir(), `hub-e2e-${shortId}`);
  const composeProject = `hub_e2e_${shortId}`.toLowerCase();
  const runDir = resolve(packageRoot, ".e2e-runs", runId);
  mkdirSync(home, { recursive: true });
  mkdirSync(runDir, { recursive: true });
  return { runId, shortId, home, composeProject, runDir };
}
