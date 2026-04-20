import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { DEFAULT_HOME_DIR } from "@agent-team-foundation/first-tree-hub-shared/config";

export type ServiceState = "active" | "inactive" | "not-installed" | "unknown";

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
  try {
    const out = execFileSync("launchctl", ["print", `${launchctlDomainTarget()}/${LAUNCHD_LABEL}`], {
      encoding: "utf-8",
      timeout: 5000,
    });
    const stateLine = out.split(/\r?\n/).find((l) => l.trim().startsWith("state ="));
    const pidLine = out.split(/\r?\n/).find((l) => l.trim().startsWith("pid ="));
    if (stateLine?.includes("running")) {
      const pid = pidLine?.split("=")[1]?.trim();
      return { state: "active", detail: pid ? `pid ${pid}` : "running" };
    }
    return { state: "inactive", detail: stateLine?.trim() ?? "loaded" };
  } catch {
    return { state: "inactive", detail: "plist present but not loaded" };
  }
}

function installLaunchd(): ServiceInfo {
  const invocation = resolveCliInvocation();
  ensureLogDir();
  const plistPath = launchdPlistPath();
  mkdirSync(dirname(plistPath), { recursive: true });
  writeFileSync(plistPath, renderPlist(invocation), { mode: 0o644 });

  const target = launchctlDomainTarget();
  // Bootout if already loaded (ignore errors — may not be loaded).
  try {
    execFileSync("launchctl", ["bootout", `${target}/${LAUNCHD_LABEL}`], {
      stdio: "ignore",
      timeout: 5000,
    });
  } catch {
    // Not loaded — fine.
  }
  execFileSync("launchctl", ["bootstrap", target, plistPath], { stdio: "ignore", timeout: 5000 });
  execFileSync("launchctl", ["enable", `${target}/${LAUNCHD_LABEL}`], {
    stdio: "ignore",
    timeout: 5000,
  });

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
  try {
    execFileSync("launchctl", ["bootout", `${target}/${LAUNCHD_LABEL}`], {
      stdio: "ignore",
      timeout: 5000,
    });
  } catch {
    // Already gone.
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
  try {
    const out = execFileSync("systemctl", ["--user", "is-active", SYSTEMD_UNIT], {
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
    if (out === "active") return { state: "active", detail: "running" };
    return { state: "inactive", detail: out };
  } catch (err) {
    const stdout =
      typeof (err as { stdout?: unknown }).stdout === "string"
        ? ((err as { stdout?: string }).stdout ?? "").trim()
        : "";
    return { state: "inactive", detail: stdout || "unit present but not active" };
  }
}

function installSystemd(): ServiceInfo {
  const invocation = resolveCliInvocation();
  ensureLogDir();
  const unitPath = systemdUnitPath();
  mkdirSync(dirname(unitPath), { recursive: true });
  writeFileSync(unitPath, renderSystemdUnit(invocation), { mode: 0o644 });

  execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore", timeout: 5000 });
  execFileSync("systemctl", ["--user", "enable", "--now", SYSTEMD_UNIT], {
    stdio: "ignore",
    timeout: 10_000,
  });

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
  try {
    execFileSync("systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT], {
      stdio: "ignore",
      timeout: 10_000,
    });
  } catch {
    // Unit not loaded — fine.
  }
  if (existsSync(unitPath)) rmSync(unitPath);
  try {
    execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore", timeout: 5000 });
  } catch {
    // systemd may not be reachable — fine for cleanup.
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
