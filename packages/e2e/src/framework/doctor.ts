import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

export type DoctorIssue = { kind: "missing" | "version" | "io"; what: string; detail: string };

function detectDockerComposeBin(): string | null {
  try {
    execFileSync("docker", ["compose", "version"], { stdio: "ignore" });
    return "docker compose";
  } catch {
    // ignore
  }
  try {
    execFileSync("docker-compose", ["version"], { stdio: "ignore" });
    return "docker-compose";
  } catch {
    return null;
  }
}

function checkNodeVersion(min: [number, number, number]): DoctorIssue | null {
  const raw = process.versions.node;
  const parts = raw.split(".").map((p) => Number.parseInt(p, 10)) as [number, number, number];
  for (let i = 0; i < 3; i++) {
    const a = parts[i] ?? 0;
    const b = min[i] ?? 0;
    if (a > b) return null;
    if (a < b)
      return {
        kind: "version",
        what: "node",
        detail: `Node ${raw} is older than required ${min.join(".")}`,
      };
  }
  return null;
}

export type DoctorResult = {
  ok: boolean;
  issues: DoctorIssue[];
  dockerComposeBin: string | null;
};

export function runDoctor(repoRoot: string): DoctorResult {
  const issues: DoctorIssue[] = [];

  const composeBin = detectDockerComposeBin();
  if (!composeBin) {
    issues.push({
      kind: "missing",
      what: "docker compose",
      detail: "Neither `docker compose` (v2) nor `docker-compose` (v1) is on PATH.",
    });
  }

  const nodeIssue = checkNodeVersion([22, 16, 0]);
  if (nodeIssue) issues.push(nodeIssue);

  const serverDist = resolve(repoRoot, "packages/server/dist/index.mjs");
  if (!existsSync(serverDist)) {
    issues.push({
      kind: "io",
      what: "server dist",
      detail: `Missing ${serverDist}. Run \`pnpm --filter @first-tree-hub/server build\` first.`,
    });
  }

  const commandDist = resolve(repoRoot, "packages/command/dist/cli/index.mjs");
  if (!existsSync(commandDist)) {
    issues.push({
      kind: "io",
      what: "command dist",
      detail: `Missing ${commandDist}. Run \`pnpm --filter @agent-team-foundation/first-tree-hub build\` first.`,
    });
  }

  return { ok: issues.length === 0, issues, dockerComposeBin: composeBin };
}
