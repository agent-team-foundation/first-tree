import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { DEFAULT_HOME_DIR } from "@agent-team-foundation/first-tree-hub-shared/config";
import { print } from "./output.js";
import type { ServiceInfo, ServiceState } from "./service-install.js";

/**
 * Hub-daemon service install — runs `first-tree-hub daemon` (server +
 * embedded ClientRuntime in one process). Independent from the legacy
 * `client.service` unit installed by `client connect --service`; the two
 * shouldn't coexist on the same machine, but the labels are distinct so a
 * stale client unit doesn't shadow the new Hub unit.
 */

const LAUNCHD_LABEL = "dev.first-tree-hub.daemon";
const SYSTEMD_UNIT = "first-tree-hub-daemon.service";
const DEFAULT_DAEMON_PORT = 8000;

type ResolvedBinary = { kind: "bin"; program: string } | { kind: "node"; program: string; args: string[] };

type ShellResult = { ok: true } | { ok: false; stderr: string; code: number | null };

function runCapture(program: string, args: string[], timeoutMs: number): ShellResult {
  const res = spawnSync(program, args, {
    encoding: "utf-8",
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (res.status === 0) return { ok: true };
  return { ok: false, stderr: (res.stderr ?? "").trim(), code: res.status };
}

function sleepSync(ms: number): void {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, ms);
}

function whichBin(name: string): string | null {
  try {
    const out = execFileSync(process.platform === "win32" ? "where" : "which", [name], {
      encoding: "utf-8",
      timeout: 3000,
    })
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    return out[0] ?? null;
  } catch {
    return null;
  }
}

function logDir(): string {
  return join(DEFAULT_HOME_DIR, "logs");
}

function ensureLogDir(): void {
  mkdirSync(logDir(), { recursive: true, mode: 0o700 });
}

function resolveCli(): ResolvedBinary {
  const bin = whichBin("first-tree-hub");
  if (bin && isAbsolute(bin)) {
    try {
      return { kind: "bin", program: realpathSync(bin) };
    } catch {
      return { kind: "bin", program: bin };
    }
  }
  const script = process.argv[1];
  if (!script) throw new Error("Cannot resolve CLI entry point (process.argv[1] is empty).");
  const scriptAbs = isAbsolute(script) ? script : join(process.cwd(), script);
  return { kind: "node", program: process.execPath, args: [scriptAbs] };
}

// ── launchd (macOS) ─────────────────────────────────────────────────

function launchdPlistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function launchctlDomainTarget(): string {
  return `gui/${userInfo().uid}`;
}

function renderPlist(invocation: ResolvedBinary, port: number): string {
  const programArgs: string[] =
    invocation.kind === "bin"
      ? [invocation.program, "daemon", "--port", String(port)]
      : [invocation.program, ...invocation.args, "daemon", "--port", String(port)];
  const argsXml = programArgs.map((a) => `    <string>${escapeXml(a)}</string>`).join("\n");
  const stdoutFallback = join(logDir(), "daemon.stdout.log");
  const stderrFallback = join(logDir(), "daemon.stderr.log");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTD/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${argsXml}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
    <key>FIRST_TREE_HUB_SERVICE_MODE</key>
    <string>1</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${escapeXml(stdoutFallback)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(stderrFallback)}</string>
</dict>
</plist>
`;
}

function waitForLabelEvicted(target: string, label: string, timeoutMs: number): boolean {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = spawnSync("launchctl", ["print", `${target}/${label}`], {
      encoding: "utf-8",
      timeout: 2000,
      stdio: ["ignore", "ignore", "pipe"],
    });
    if (res.status !== 0) return true;
    sleepSync(200);
  }
  return false;
}

function launchdState(): { state: ServiceState; detail?: string } {
  const plist = launchdPlistPath();
  if (!existsSync(plist)) return { state: "not-installed" };
  const res = spawnSync("launchctl", ["print", `${launchctlDomainTarget()}/${LAUNCHD_LABEL}`], {
    encoding: "utf-8",
    timeout: 5000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (res.status !== 0) return { state: "inactive", detail: "plist present but not loaded" };
  const out = res.stdout ?? "";
  const stateLine = out.split(/\r?\n/).find((l) => l.trim().startsWith("state ="));
  const pidLine = out.split(/\r?\n/).find((l) => l.trim().startsWith("pid ="));
  if (stateLine?.includes("running")) {
    const pid = pidLine?.split("=")[1]?.trim();
    return { state: "active", detail: pid ? `pid ${pid}` : "running" };
  }
  return { state: "inactive", detail: stateLine?.trim() ?? "loaded" };
}

function installLaunchd(port: number): ServiceInfo {
  const invocation = resolveCli();
  ensureLogDir();
  const plistPath = launchdPlistPath();
  mkdirSync(dirname(plistPath), { recursive: true });
  writeFileSync(plistPath, renderPlist(invocation, port), { mode: 0o644 });

  const target = launchctlDomainTarget();

  const bootoutRes = runCapture("launchctl", ["bootout", `${target}/${LAUNCHD_LABEL}`], 15_000);
  if (!bootoutRes.ok && !/not find|no such|not loaded/i.test(bootoutRes.stderr)) {
    print.line(`    warning: launchctl bootout: ${bootoutRes.stderr || `exit ${bootoutRes.code ?? "unknown"}`}\n`);
  }
  waitForLabelEvicted(target, LAUNCHD_LABEL, 10_000);

  let lastErr: ShellResult | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = runCapture("launchctl", ["bootstrap", target, plistPath], 10_000);
    if (res.ok) {
      lastErr = null;
      break;
    }
    lastErr = res;
    if (attempt < 2) sleepSync(1_000);
  }
  if (lastErr) {
    throw new Error(
      `launchctl bootstrap failed: ${lastErr.stderr || `exit ${lastErr.code ?? "unknown"}`}\n` +
        `    Recovery: \`launchctl bootout ${target}/${LAUNCHD_LABEL}\` then \`first-tree-hub start --service\`.`,
    );
  }

  const enableRes = runCapture("launchctl", ["enable", `${target}/${LAUNCHD_LABEL}`], 5_000);
  if (!enableRes.ok) {
    print.line(`    warning: launchctl enable: ${enableRes.stderr || `exit ${enableRes.code ?? "unknown"}`}\n`);
  }

  const { state, detail } = launchdState();
  return { platform: "launchd", label: LAUNCHD_LABEL, unitPath: plistPath, logDir: logDir(), state, detail };
}

function uninstallLaunchd(): ServiceInfo {
  const plistPath = launchdPlistPath();
  const target = launchctlDomainTarget();
  const res = runCapture("launchctl", ["bootout", `${target}/${LAUNCHD_LABEL}`], 15_000);
  if (!res.ok && !/not find|no such|not loaded/i.test(res.stderr)) {
    print.line(`    warning: bootout during uninstall: ${res.stderr || `exit ${res.code ?? "unknown"}`}\n`);
  }
  if (existsSync(plistPath)) rmSync(plistPath);
  return {
    platform: "launchd",
    label: LAUNCHD_LABEL,
    unitPath: plistPath,
    logDir: logDir(),
    state: "not-installed",
  };
}

function stopLaunchd(): void {
  const target = launchctlDomainTarget();
  const res = runCapture("launchctl", ["kill", "SIGTERM", `${target}/${LAUNCHD_LABEL}`], 10_000);
  if (!res.ok && !/not find|no such|not loaded/i.test(res.stderr)) {
    print.line(`    warning: launchctl kill: ${res.stderr || `exit ${res.code ?? "unknown"}`}\n`);
  }
}

// ── systemd --user (Linux) ──────────────────────────────────────────

function systemdUnitPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(xdg, "systemd", "user", SYSTEMD_UNIT);
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_\-./:=]+$/.test(value)) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function renderSystemdUnit(invocation: ResolvedBinary, port: number): string {
  const baseCmd =
    invocation.kind === "bin"
      ? shellQuote(invocation.program)
      : `${shellQuote(invocation.program)} ${invocation.args.map(shellQuote).join(" ")}`;
  const execStart = `${baseCmd} daemon --port ${port}`;
  return `[Unit]
Description=First Tree Hub Daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${execStart}
Restart=always
RestartSec=10
StandardOutput=append:${join(logDir(), "daemon.stdout.log")}
StandardError=append:${join(logDir(), "daemon.stderr.log")}
Environment=PATH=/usr/local/bin:/usr/bin:/bin
Environment=FIRST_TREE_HUB_SERVICE_MODE=1

[Install]
WantedBy=default.target
`;
}

function systemdState(): { state: ServiceState; detail?: string } {
  const unitPath = systemdUnitPath();
  if (!existsSync(unitPath)) return { state: "not-installed" };
  const res = spawnSync("systemctl", ["--user", "is-active", SYSTEMD_UNIT], {
    encoding: "utf-8",
    timeout: 5000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const out = (res.stdout ?? "").trim();
  if (res.status === 0 && out === "active") return { state: "active", detail: "running" };
  return { state: "inactive", detail: out || "unit present but not active" };
}

function installSystemd(port: number): ServiceInfo {
  const invocation = resolveCli();
  ensureLogDir();
  const unitPath = systemdUnitPath();
  mkdirSync(dirname(unitPath), { recursive: true });
  writeFileSync(unitPath, renderSystemdUnit(invocation, port), { mode: 0o644 });

  const reloadRes = runCapture("systemctl", ["--user", "daemon-reload"], 5_000);
  if (!reloadRes.ok) {
    throw new Error(
      `systemctl --user daemon-reload failed: ${reloadRes.stderr || `exit ${reloadRes.code ?? "unknown"}`}`,
    );
  }
  const enableRes = runCapture("systemctl", ["--user", "enable", "--now", SYSTEMD_UNIT], 10_000);
  if (!enableRes.ok) {
    throw new Error(
      `systemctl --user enable --now ${SYSTEMD_UNIT} failed: ${enableRes.stderr || `exit ${enableRes.code ?? "unknown"}`}\n` +
        `    Recovery: \`systemctl --user stop ${SYSTEMD_UNIT}\` then \`first-tree-hub start --service\`.`,
    );
  }

  const { state, detail } = systemdState();
  return { platform: "systemd", label: SYSTEMD_UNIT, unitPath, logDir: logDir(), state, detail };
}

function uninstallSystemd(): ServiceInfo {
  const unitPath = systemdUnitPath();
  const disableRes = runCapture("systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT], 10_000);
  if (!disableRes.ok && !/not found|no such|not loaded/i.test(disableRes.stderr)) {
    print.line(
      `    warning: systemctl disable during uninstall: ${disableRes.stderr || `exit ${disableRes.code ?? "unknown"}`}\n`,
    );
  }
  if (existsSync(unitPath)) rmSync(unitPath);
  const reloadRes = runCapture("systemctl", ["--user", "daemon-reload"], 5_000);
  if (!reloadRes.ok) {
    print.line(
      `    warning: systemctl daemon-reload during uninstall: ${reloadRes.stderr || `exit ${reloadRes.code ?? "unknown"}`}\n`,
    );
  }
  return { platform: "systemd", label: SYSTEMD_UNIT, unitPath, logDir: logDir(), state: "not-installed" };
}

function stopSystemd(): void {
  const res = runCapture("systemctl", ["--user", "stop", SYSTEMD_UNIT], 10_000);
  if (!res.ok && !/not loaded/i.test(res.stderr)) {
    print.line(`    warning: systemctl --user stop: ${res.stderr || `exit ${res.code ?? "unknown"}`}\n`);
  }
}

// ── public API ──────────────────────────────────────────────────────

export const HUB_DAEMON_DEFAULT_PORT = DEFAULT_DAEMON_PORT;

export function isHubServiceSupported(): boolean {
  return process.platform === "darwin" || process.platform === "linux";
}

export function installHubService(options: { port: number }): ServiceInfo {
  if (process.platform === "darwin") return installLaunchd(options.port);
  if (process.platform === "linux") return installSystemd(options.port);
  throw new Error(
    `Background service install is not supported on ${process.platform}. ` +
      "Run `first-tree-hub start` (foreground) instead.",
  );
}

export function getHubServiceStatus(): ServiceInfo {
  if (process.platform === "darwin") {
    const { state, detail } = launchdState();
    return {
      platform: "launchd",
      label: LAUNCHD_LABEL,
      unitPath: launchdPlistPath(),
      logDir: logDir(),
      state,
      detail,
    };
  }
  if (process.platform === "linux") {
    const { state, detail } = systemdState();
    return {
      platform: "systemd",
      label: SYSTEMD_UNIT,
      unitPath: systemdUnitPath(),
      logDir: logDir(),
      state,
      detail,
    };
  }
  return {
    platform: "unsupported",
    label: "",
    unitPath: "",
    logDir: logDir(),
    state: "not-installed",
    detail: `platform ${process.platform} not supported`,
  };
}

export function uninstallHubService(): ServiceInfo {
  if (process.platform === "darwin") return uninstallLaunchd();
  if (process.platform === "linux") return uninstallSystemd();
  return getHubServiceStatus();
}

export function stopHubService(): void {
  if (process.platform === "darwin") {
    stopLaunchd();
    return;
  }
  if (process.platform === "linux") {
    stopSystemd();
  }
}
