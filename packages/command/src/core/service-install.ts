import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { DEFAULT_HOME_DIR } from "@agent-team-foundation/first-tree-hub-shared/config";

export type ServiceState = "active" | "inactive" | "not-installed" | "unknown";

type ShellResult = { ok: true } | { ok: false; stderr: string; code: number | null };

/**
 * Run a subprocess capturing stderr so failures surface a meaningful error
 * instead of Node's opaque "Command failed". Used for launchctl/systemctl —
 * anywhere the stderr message is diagnostically crucial.
 */
function runCapture(program: string, args: string[], timeoutMs: number): ShellResult {
  const res = spawnSync(program, args, {
    encoding: "utf-8",
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (res.status === 0) return { ok: true };
  return {
    ok: false,
    stderr: (res.stderr ?? "").trim(),
    code: res.status,
  };
}

function sleepSync(ms: number): void {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, ms);
}

export type ServiceInfo = {
  platform: "launchd" | "systemd" | "unsupported";
  label: string;
  unitPath: string;
  logDir: string;
  state: ServiceState;
  detail?: string;
};

const LAUNCHD_LABEL = "dev.first-tree-hub.client";
const SYSTEMD_UNIT = "first-tree-hub-client.service";
const LOG_DIR = join(DEFAULT_HOME_DIR, "logs");

type ResolvedBinary = { kind: "bin"; program: string } | { kind: "node"; program: string; args: string[] };

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

/**
 * Resolve how the service should launch the CLI.
 *
 * Prefers the installed `first-tree-hub` bin on PATH (usually a shim under
 * /usr/local/bin or ~/.npm-global/bin). Falls back to invoking the current
 * Node interpreter against the running script (handles `pnpm dev`, tsx, and
 * dev-only global installs).
 */
export function resolveCliInvocation(): ResolvedBinary {
  const bin = whichBin("first-tree-hub");
  if (bin && isAbsolute(bin)) {
    try {
      // Resolve symlinks so launchd records a stable path.
      return { kind: "bin", program: realpathSync(bin) };
    } catch {
      return { kind: "bin", program: bin };
    }
  }

  const script = process.argv[1];
  if (!script) {
    throw new Error("Cannot resolve CLI entry point (process.argv[1] is empty).");
  }
  const scriptAbs = isAbsolute(script) ? script : join(process.cwd(), script);
  return { kind: "node", program: process.execPath, args: [scriptAbs] };
}

function ensureLogDir(): void {
  mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
}

// ── launchd (macOS) ─────────────────────────────────────────────────

function launchdPlistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

function renderPlist(invocation: ResolvedBinary): string {
  const programArgs: string[] =
    invocation.kind === "bin"
      ? [invocation.program, "client", "start", "--no-interactive"]
      : [invocation.program, ...invocation.args, "client", "start", "--no-interactive"];

  const argsXml = programArgs.map((a) => `    <string>${escapeXml(a)}</string>`).join("\n");
  const outLog = join(LOG_DIR, "client.out.log");
  const errLog = join(LOG_DIR, "client.err.log");

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
  <string>${escapeXml(outLog)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(errLog)}</string>
</dict>
</plist>
`;
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function launchctlDomainTarget(): string {
  return `gui/${userInfo().uid}`;
}

function launchdState(): { state: ServiceState; detail?: string } {
  const plist = launchdPlistPath();
  if (!existsSync(plist)) return { state: "not-installed" };
  // Use spawnSync with explicit stderr:"pipe" so launchctl's "Could not
  // find service" message doesn't leak onto the user's terminal when the
  // label isn't currently loaded. execFileSync defaults stderr to inherit.
  const res = spawnSync("launchctl", ["print", `${launchctlDomainTarget()}/${LAUNCHD_LABEL}`], {
    encoding: "utf-8",
    timeout: 5000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (res.status !== 0) {
    return { state: "inactive", detail: "plist present but not loaded" };
  }
  const out = res.stdout ?? "";
  const stateLine = out.split(/\r?\n/).find((l) => l.trim().startsWith("state ="));
  const pidLine = out.split(/\r?\n/).find((l) => l.trim().startsWith("pid ="));
  if (stateLine?.includes("running")) {
    const pid = pidLine?.split("=")[1]?.trim();
    return { state: "active", detail: pid ? `pid ${pid}` : "running" };
  }
  return { state: "inactive", detail: stateLine?.trim() ?? "loaded" };
}

/**
 * Poll `launchctl print` until the label disappears, confirming launchd has
 * finished the async eviction kicked off by `bootout`. Required because
 * `bootout` returns before the actual unload completes when the service has
 * active WebSocket connections — a follow-up `bootstrap` against a still-
 * registered label fails with `Bootstrap failed: 5: Input/output error`.
 */
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

function installLaunchd(): ServiceInfo {
  const invocation = resolveCliInvocation();
  ensureLogDir();
  const plistPath = launchdPlistPath();
  mkdirSync(dirname(plistPath), { recursive: true });
  writeFileSync(plistPath, renderPlist(invocation), { mode: 0o644 });

  const target = launchctlDomainTarget();

  // Step 1: bootout any existing registration. Generous timeout because
  // tearing down an active service (SIGTERM → WS close → process exit)
  // routinely takes several seconds when there are live connections.
  const bootoutRes = runCapture("launchctl", ["bootout", `${target}/${LAUNCHD_LABEL}`], 15_000);
  if (!bootoutRes.ok) {
    const notLoaded = /not find|no such|not loaded/i.test(bootoutRes.stderr);
    if (!notLoaded) {
      // Unexpected bootout error — surface it but don't fail; waitForLabelEvicted
      // will give it a final chance to clear.
      process.stderr.write(
        `    warning: launchctl bootout: ${bootoutRes.stderr || `exit ${bootoutRes.code ?? "unknown"}`}\n`,
      );
    }
  }

  // Step 2: poll until launchd has actually evicted the label. Without this,
  // `bootstrap` collides with the still-unloading registration.
  waitForLabelEvicted(target, LAUNCHD_LABEL, 10_000);

  // Step 3: bootstrap with one retry. If the poll missed a late eviction,
  // a 1s wait + retry recovers instead of exploding with a cryptic error.
  let lastBootstrapErr: ShellResult | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = runCapture("launchctl", ["bootstrap", target, plistPath], 10_000);
    if (res.ok) {
      lastBootstrapErr = null;
      break;
    }
    lastBootstrapErr = res;
    if (attempt < 2) sleepSync(1_000);
  }
  if (lastBootstrapErr) {
    throw new Error(
      `launchctl bootstrap failed: ${lastBootstrapErr.stderr || `exit ${lastBootstrapErr.code ?? "unknown"}`}\n` +
        `    Command: launchctl bootstrap ${target} ${plistPath}\n` +
        `    Recovery: \`launchctl bootout ${target}/${LAUNCHD_LABEL}\` then \`first-tree-hub service install\`.`,
    );
  }

  // Step 4: enable. Non-fatal if it fails (service already bootstrapped).
  const enableRes = runCapture("launchctl", ["enable", `${target}/${LAUNCHD_LABEL}`], 5_000);
  if (!enableRes.ok) {
    process.stderr.write(
      `    warning: launchctl enable: ${enableRes.stderr || `exit ${enableRes.code ?? "unknown"}`}\n`,
    );
  }

  const { state, detail } = launchdState();
  return {
    platform: "launchd",
    label: LAUNCHD_LABEL,
    unitPath: plistPath,
    logDir: LOG_DIR,
    state,
    detail,
  };
}

function uninstallLaunchd(): ServiceInfo {
  const plistPath = launchdPlistPath();
  const target = launchctlDomainTarget();
  const res = runCapture("launchctl", ["bootout", `${target}/${LAUNCHD_LABEL}`], 15_000);
  if (!res.ok && !/not find|no such|not loaded/i.test(res.stderr)) {
    process.stderr.write(`    warning: bootout during uninstall: ${res.stderr || `exit ${res.code ?? "unknown"}`}\n`);
  }
  if (existsSync(plistPath)) rmSync(plistPath);
  return {
    platform: "launchd",
    label: LAUNCHD_LABEL,
    unitPath: plistPath,
    logDir: LOG_DIR,
    state: "not-installed",
  };
}

// ── systemd --user (Linux) ──────────────────────────────────────────

function systemdUnitPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(xdg, "systemd", "user", SYSTEMD_UNIT);
}

function renderSystemdUnit(invocation: ResolvedBinary): string {
  const execStart: string =
    invocation.kind === "bin"
      ? `${shellQuote(invocation.program)} client start --no-interactive`
      : `${shellQuote(invocation.program)} ${invocation.args.map(shellQuote).join(" ")} client start --no-interactive`;

  return `[Unit]
Description=First Tree Hub Client
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${execStart}
Restart=always
RestartSec=10
StandardOutput=append:${join(LOG_DIR, "client.out.log")}
StandardError=append:${join(LOG_DIR, "client.err.log")}
Environment=PATH=/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=default.target
`;
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_\-./:=]+$/.test(value)) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function systemdState(): { state: ServiceState; detail?: string } {
  const unitPath = systemdUnitPath();
  if (!existsSync(unitPath)) return { state: "not-installed" };
  // Mirror the launchctl fix: keep stderr piped so systemctl's error text
  // ("Failed to connect to bus..." etc.) doesn't leak to the user's terminal.
  const res = spawnSync("systemctl", ["--user", "is-active", SYSTEMD_UNIT], {
    encoding: "utf-8",
    timeout: 5000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const out = (res.stdout ?? "").trim();
  if (res.status === 0 && out === "active") return { state: "active", detail: "running" };
  return { state: "inactive", detail: out || "unit present but not active" };
}

function installSystemd(): ServiceInfo {
  const invocation = resolveCliInvocation();
  ensureLogDir();
  const unitPath = systemdUnitPath();
  mkdirSync(dirname(unitPath), { recursive: true });
  writeFileSync(unitPath, renderSystemdUnit(invocation), { mode: 0o644 });

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
        `    Recovery: \`systemctl --user stop ${SYSTEMD_UNIT}\` then \`first-tree-hub service install\`.`,
    );
  }

  const { state, detail } = systemdState();
  return {
    platform: "systemd",
    label: SYSTEMD_UNIT,
    unitPath,
    logDir: LOG_DIR,
    state,
    detail,
  };
}

function uninstallSystemd(): ServiceInfo {
  const unitPath = systemdUnitPath();
  const disableRes = runCapture("systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT], 10_000);
  if (!disableRes.ok && !/not found|no such|not loaded/i.test(disableRes.stderr)) {
    process.stderr.write(
      `    warning: systemctl disable during uninstall: ${disableRes.stderr || `exit ${disableRes.code ?? "unknown"}`}\n`,
    );
  }
  if (existsSync(unitPath)) rmSync(unitPath);
  const reloadRes = runCapture("systemctl", ["--user", "daemon-reload"], 5_000);
  if (!reloadRes.ok) {
    process.stderr.write(
      `    warning: systemctl daemon-reload during uninstall: ${reloadRes.stderr || `exit ${reloadRes.code ?? "unknown"}`}\n`,
    );
  }
  return {
    platform: "systemd",
    label: SYSTEMD_UNIT,
    unitPath,
    logDir: LOG_DIR,
    state: "not-installed",
  };
}

// ── Public API ──────────────────────────────────────────────────────

/** Is background-service install supported on the current platform? */
export function isServiceSupported(): boolean {
  return process.platform === "darwin" || process.platform === "linux";
}

/**
 * Install the background service for the current platform.
 *
 * @throws {Error} if the platform is not supported or the service manager fails.
 */
export function installClientService(): ServiceInfo {
  if (process.platform === "darwin") return installLaunchd();
  if (process.platform === "linux") return installSystemd();
  throw new Error(
    `Background service install is not supported on ${process.platform}. ` +
      "Run `first-tree-hub client start` manually to keep the computer online.",
  );
}

/** Report the current service state without modifying anything. */
export function getClientServiceStatus(): ServiceInfo {
  if (process.platform === "darwin") {
    const { state, detail } = launchdState();
    return {
      platform: "launchd",
      label: LAUNCHD_LABEL,
      unitPath: launchdPlistPath(),
      logDir: LOG_DIR,
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
      logDir: LOG_DIR,
      state,
      detail,
    };
  }
  return {
    platform: "unsupported",
    label: "",
    unitPath: "",
    logDir: LOG_DIR,
    state: "not-installed",
    detail: `platform ${process.platform} not supported`,
  };
}

/** Uninstall the background service. No-op if not installed. */
export function uninstallClientService(): ServiceInfo {
  if (process.platform === "darwin") return uninstallLaunchd();
  if (process.platform === "linux") return uninstallSystemd();
  return getClientServiceStatus();
}
