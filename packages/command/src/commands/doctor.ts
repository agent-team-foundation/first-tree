import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG_DIR, readConfigFile } from "@agent-hub/shared/config";
import type { Command } from "commander";
import { blank } from "../cli/output.js";

type CheckResult = {
  label: string;
  ok: boolean;
  detail: string;
};

export function registerDoctorCommand(program: Command): void {
  program
    .command("doctor")
    .description("Check environment readiness for running Agent Hub")
    .action(async () => {
      process.stderr.write("\n  Agent Hub Doctor\n\n");

      const results: CheckResult[] = [];

      // 1. Node.js version
      results.push(checkNodeVersion());

      // 2. Docker available
      results.push(checkDocker());

      // 3. Config files
      results.push(checkConfigFile("server"));
      results.push(checkConfigFile("client"));

      // 4. Database connectivity
      results.push(await checkDatabase());

      // 5. Server running
      results.push(await checkServerHealth());

      // 6. GitHub token
      results.push(await checkGitHubToken());

      // 7. Port availability
      results.push(await checkPort());

      // Print results
      for (const r of results) {
        const icon = r.ok ? "\u2713" : "\u2717";
        process.stderr.write(`  ${icon} ${r.label.padEnd(22)} ${r.detail}\n`);
      }

      blank();

      const failures = results.filter((r) => !r.ok);
      if (failures.length === 0) {
        process.stderr.write("  All checks passed.\n");
      } else {
        process.stderr.write(`  ${failures.length} issue(s) found.\n`);
      }
      blank();
    });
}

function checkNodeVersion(): CheckResult {
  const version = process.versions.node;
  const [major] = version.split(".").map(Number);
  const ok = major !== undefined && major >= 22;
  return {
    label: "Node.js",
    ok,
    detail: ok ? `v${version}` : `v${version} (requires >= 22.16)`,
  };
}

function checkDocker(): CheckResult {
  try {
    const output = execFileSync("docker", ["--version"], { encoding: "utf-8", timeout: 5000 }).trim();
    return { label: "Docker", ok: true, detail: output.replace("Docker version ", "v").split(",")[0] ?? "" };
  } catch {
    return { label: "Docker", ok: false, detail: "not found (optional — needed for auto PG provisioning)" };
  }
}

function checkConfigFile(role: "server" | "client"): CheckResult {
  const configPath = join(DEFAULT_CONFIG_DIR, `${role}.yaml`);
  const exists = existsSync(configPath);
  return {
    label: `Config (${role})`,
    ok: exists,
    detail: exists ? configPath : `not found — run: agent-hub config setup -${role[0]}`,
  };
}

async function checkDatabase(): Promise<CheckResult> {
  const serverConfig = readConfigFile(join(DEFAULT_CONFIG_DIR, "server.yaml"));
  const dbUrl = getNestedValue(serverConfig, "database.url");
  if (typeof dbUrl !== "string" || !dbUrl) {
    return { label: "Database", ok: false, detail: "no database URL configured" };
  }

  try {
    // Dynamic import to avoid loading postgres at module level
    const { default: pg } = (await import("postgres")) as { default: (url: string, opts: unknown) => unknown };
    const sql = pg(dbUrl, { max: 1, connect_timeout: 5, idle_timeout: 1 }) as {
      unsafe: (q: string) => Promise<unknown>;
      end: () => Promise<void>;
    };
    await sql.unsafe("SELECT 1");
    await sql.end();
    return { label: "Database", ok: true, detail: "connected" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { label: "Database", ok: false, detail: `unreachable — ${msg.slice(0, 80)}` };
  }
}

async function checkServerHealth(): Promise<CheckResult> {
  const serverConfig = readConfigFile(join(DEFAULT_CONFIG_DIR, "server.yaml"));
  const port = getNestedValue(serverConfig, "server.port") ?? 8000;
  const host = getNestedValue(serverConfig, "server.host") ?? "127.0.0.1";
  const url = `http://${host}:${port}/healthz`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      return { label: "Server", ok: true, detail: `running at ${host}:${port}` };
    }
    return { label: "Server", ok: false, detail: `unhealthy (HTTP ${res.status})` };
  } catch {
    return { label: "Server", ok: false, detail: `not running at ${host}:${port}` };
  }
}

async function checkGitHubToken(): Promise<CheckResult> {
  const serverConfig = readConfigFile(join(DEFAULT_CONFIG_DIR, "server.yaml"));
  const token = getNestedValue(serverConfig, "github.token") ?? process.env.AGENT_HUB_GITHUB_TOKEN;
  if (typeof token !== "string" || !token) {
    return { label: "GitHub Token", ok: false, detail: "not configured" };
  }

  try {
    const res = await fetch("https://api.github.com/user", {
      headers: { Authorization: `token ${token}`, Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const data = (await res.json()) as { login?: string };
      return { label: "GitHub Token", ok: true, detail: `valid (${data.login})` };
    }
    return { label: "GitHub Token", ok: false, detail: `invalid (HTTP ${res.status})` };
  } catch {
    return { label: "GitHub Token", ok: false, detail: "could not reach api.github.com" };
  }
}

async function checkPort(): Promise<CheckResult> {
  const serverConfig = readConfigFile(join(DEFAULT_CONFIG_DIR, "server.yaml"));
  const port = (getNestedValue(serverConfig, "server.port") as number) ?? 8000;

  try {
    // Try to connect — if it succeeds, something is already listening
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1000) });
    if (res.ok) {
      return { label: `Port ${port}`, ok: true, detail: "in use by Agent Hub" };
    }
    return { label: `Port ${port}`, ok: false, detail: "in use by another process" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    if (msg.includes("ECONNREFUSED") || msg.includes("fetch failed") || msg.includes("aborted")) {
      return { label: `Port ${port}`, ok: true, detail: "available" };
    }
    return { label: `Port ${port}`, ok: true, detail: "available" };
  }
}

function getNestedValue(obj: Record<string, unknown>, dotPath: string): unknown {
  const parts = dotPath.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
