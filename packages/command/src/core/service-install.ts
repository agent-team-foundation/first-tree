import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { DEFAULT_HOME_DIR } from "@agent-team-foundation/first-tree-hub-shared/config";
import { print } from "./output.js";

export type ServiceState = "active" | "inactive" | "not-installed" | "unknown";

type ShellResult = { ok: true } | { ok: false; stderr: string; code: number | null };
type ShellOutResult = { ok: true; stdout: string } | { ok: false; stderr: string; code: number | null };

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

/** Same as runCapture but also returns stdout — for queries (loginctl show-user, etc.). */
function runCaptureOut(program: string, args: string[], timeoutMs: number): ShellOutResult {
  const res = spawnSync(program, args, {
    encoding: "utf-8",
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (res.status === 0) return { ok: true, stdout: (res.stdout ?? "").trim() };
  return { ok: false, stderr: (res.stderr ?? "").trim(), code: res.status };
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
  /** PID of the active service process, if running. */
  pid?: number;
  detail?: string;
};

/** Result of a start / stop / restart call against the service manager. */
export type ServiceOpResult = { ok: true; detail?: string } | { ok: false; reason: string };

/**
 * Map a `FIRST_TREE_HUB_HOME` basename to the suffix appended to the
 * service manager's unit name / label.
 *
 * Why this exists: `FIRST_TREE_HUB_HOME` already isolates config /
 * credentials / workspace under a separate home dir, but until now the
 * systemd unit name and launchd label were hard-coded — so a developer
 * running with an isolated home would still rewrite the same
 * `first-tree-hub-client.service` unit file as the prod install. This
 * derivation closes that loop: dev homes get their own unit name and
 * coexist with prod.
 *
 * Rule:
 *   - "hub" → ""        (default home; preserves the existing prod
 *                        unit name `first-tree-hub-client.service` for
 *                        every machine already in the field)
 *   - "hub-<x>" → "<x>" ("hub-test" → "test", giving
 *                        `first-tree-hub-client-test.service`)
 *   - anything else → the basename verbatim (a custom home like
 *                     "~/.first-tree/foo" yields suffix "foo")
 *
 * Empty / falsy basenames defensively fall back to the default — we
 * never want to silently drop a user's intent into prod's unit name.
 */
export function deriveServiceSuffix(homeBasename: string): string {
  if (!homeBasename) return "";
  if (homeBasename === "hub") return "";
  if (homeBasename.startsWith("hub-")) return homeBasename.slice("hub-".length);
  return homeBasename;
}

const SERVICE_SUFFIX = deriveServiceSuffix(basename(DEFAULT_HOME_DIR));
const LAUNCHD_LABEL = SERVICE_SUFFIX ? `dev.first-tree-hub.client.${SERVICE_SUFFIX}` : "dev.first-tree-hub.client";
const SYSTEMD_UNIT = SERVICE_SUFFIX
  ? `first-tree-hub-client-${SERVICE_SUFFIX}.service`
  : "first-tree-hub-client.service";
const SYSLOG_IDENT = SERVICE_SUFFIX ? `first-tree-hub-client-${SERVICE_SUFFIX}` : "first-tree-hub-client";
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
 * Two regimes:
 *
 *   ① Prod (default home, empty service suffix) — prefer the installed
 *      `first-tree-hub` bin on PATH (usually a shim under /usr/local/bin
 *      or ~/.npm-global/bin). Using the shim means an `npm i -g … @latest`
 *      atomically swaps the binary the unit launches, no unit rewrite
 *      needed.
 *
 *   ② Dev / isolated (non-empty suffix from a custom FIRST_TREE_HUB_HOME)
 *      — pin to the running interpreter + script path. This skips the
 *      PATH lookup, which would otherwise resolve `first-tree-hub` to
 *      the operator's prod global install — making the dev unit silently
 *      run prod code against a dev home (i.e., the whole isolation story
 *      collapses with no error message). Pinning execPath+argv[1] forces
 *      the dev unit to launch the dev build that just installed it.
 */
export function resolveCliInvocation(serviceSuffix: string = SERVICE_SUFFIX): ResolvedBinary {
  if (serviceSuffix === "") {
    const bin = whichBin("first-tree-hub");
    if (bin && isAbsolute(bin)) {
      try {
        // Resolve symlinks so launchd records a stable path.
        return { kind: "bin", program: realpathSync(bin) };
      } catch {
        return { kind: "bin", program: bin };
      }
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
  // launchd's StandardOutPath / StandardErrorPath are the fallback sink — they
  // only catch bare stdout/stderr (crash messages, third-party spam) because
  // the client's own logger writes a rotating NDJSON file at `client.log`
  // via FIRST_TREE_HUB_SERVICE_MODE. Naming these `.stdout.log` / `.stderr.log`
  // keeps that role explicit for anyone inspecting the logs dir.
  const stdoutFallback = join(LOG_DIR, "client.stdout.log");
  const stderrFallback = join(LOG_DIR, "client.stderr.log");

  // Mirror the systemd-side fix: dev installs (non-empty suffix) need
  // FIRST_TREE_HUB_HOME baked into the launched env, otherwise launchd
  // strips the user's shell env on `bootstrap` and the process falls
  // back to the default home → silently reads prod's client.yaml.
  const homeEnvXml = SERVICE_SUFFIX
    ? `\n    <key>FIRST_TREE_HUB_HOME</key>\n    <string>${escapeXml(DEFAULT_HOME_DIR)}</string>`
    : "";

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
    <string>1</string>${homeEnvXml}
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

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function launchctlDomainTarget(): string {
  return `gui/${userInfo().uid}`;
}

function launchdState(): { state: ServiceState; pid?: number; detail?: string } {
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
    const pidStr = pidLine?.split("=")[1]?.trim();
    const pidNum = pidStr ? Number(pidStr) : Number.NaN;
    const pid = Number.isFinite(pidNum) && pidNum > 0 ? pidNum : undefined;
    return { state: "active", pid, detail: pid ? `pid ${pid}` : "running" };
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
      print.line(`    warning: launchctl bootout: ${bootoutRes.stderr || `exit ${bootoutRes.code ?? "unknown"}`}\n`);
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
        `    Recovery: \`launchctl bootout ${target}/${LAUNCHD_LABEL}\` then \`first-tree-hub client connect <server-url>\`.`,
    );
  }

  // Step 4: enable. Non-fatal if it fails (service already bootstrapped).
  const enableRes = runCapture("launchctl", ["enable", `${target}/${LAUNCHD_LABEL}`], 5_000);
  if (!enableRes.ok) {
    print.line(`    warning: launchctl enable: ${enableRes.stderr || `exit ${enableRes.code ?? "unknown"}`}\n`);
  }

  const { state, pid, detail } = launchdState();
  return {
    platform: "launchd",
    label: LAUNCHD_LABEL,
    unitPath: plistPath,
    logDir: LOG_DIR,
    state,
    pid,
    detail,
  };
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

  // Pin FIRST_TREE_HUB_HOME into the unit when this install is itself
  // running with a non-default home. Without this line, systemd's launched
  // process inherits only the user manager's env, FIRST_TREE_HUB_HOME is
  // unset, and the process silently falls back to the default `~/.first-tree/hub`
  // — i.e. a "dev" unit ends up reading prod's client.yaml. The
  // home-derived suffix gives us isolated unit names; this gives the
  // launched process the matching home so the isolation actually holds.
  // Prod (suffix === "") deliberately omits the line so existing
  // installed units don't churn unnecessarily.
  const homeEnv = SERVICE_SUFFIX ? `Environment=FIRST_TREE_HUB_HOME=${shellQuote(DEFAULT_HOME_DIR)}\n` : "";

  // Restart policy split:
  //   - on-failure  → operator-issued `systemctl stop` (clean exit 0) really stops.
  //   - SuccessExitStatus=0 makes that explicit.
  //   - RestartForceExitStatus=75 keeps the self-update path working: the
  //     UpdateManager exits 75 after `npm i -g`, systemd sees it as a
  //     "must restart" signal and brings up the new binary.
  // StartLimit* caps a crash storm (10 failures in 5 min → systemd holds back).
  // Logs go through journald — `journalctl --user -u first-tree-hub-client` is
  // the documented surface. The client itself still writes its rotating NDJSON
  // to client.log when FIRST_TREE_HUB_SERVICE_MODE=1; journald only catches
  // bare stdout/stderr (crashes, third-party spam).
  return `[Unit]
Description=First Tree Hub Client
StartLimitIntervalSec=300
StartLimitBurst=10

[Service]
Type=simple
ExecStart=${execStart}
Restart=on-failure
RestartSec=10
SuccessExitStatus=0
RestartForceExitStatus=75
KillSignal=SIGTERM
KillMode=mixed
TimeoutStopSec=30
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${SYSLOG_IDENT}
Environment=PATH=/usr/local/bin:/usr/bin:/bin
Environment=FIRST_TREE_HUB_SERVICE_MODE=1
${homeEnv}[Install]
WantedBy=default.target
`;
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_\-./:=]+$/.test(value)) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function systemdState(): { state: ServiceState; pid?: number; detail?: string } {
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
  if (res.status === 0 && out === "active") {
    const pid = readSystemdMainPid();
    return { state: "active", pid, detail: pid ? `pid ${pid}` : "running" };
  }
  return { state: "inactive", detail: out || "unit present but not active" };
}

function readSystemdMainPid(): number | undefined {
  const res = runCaptureOut("systemctl", ["--user", "show", SYSTEMD_UNIT, "-p", "MainPID", "--value"], 5000);
  if (!res.ok) return undefined;
  const n = Number(res.stdout);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Best-effort `loginctl enable-linger` for the current user.
 *
 * Why this matters: a `--user` systemd service is tied to the user's session.
 * Without linger, when the user logs out (closes their last SSH session,
 * graphical session ends, etc.) the user's systemd manager exits and stops
 * every service it owns — including ours. The next login restarts everything,
 * which is silently wrong: agents go offline for hours and the operator has
 * no obvious cause.
 *
 * `enable-linger <self>` is allowed without sudo on systemd ≥ 240 thanks to
 * polkit's `org.freedesktop.login1.set-self-linger` rule. On older distros
 * or hardened setups it requires polkit auth — we don't try to escalate;
 * the warning printed by the caller is the operator's signal to run it
 * manually.
 */
function tryEnableLinger(): { ok: true; alreadyOn: boolean } | { ok: false; reason: string } {
  const username = userInfo().username;
  if (!username) return { ok: false, reason: "could not determine username" };

  // Idempotency check: skip the call if linger is already on.
  const showRes = runCaptureOut("loginctl", ["show-user", username, "-p", "Linger", "--value"], 5_000);
  if (showRes.ok && showRes.stdout === "yes") {
    return { ok: true, alreadyOn: true };
  }

  const res = runCapture("loginctl", ["enable-linger", username], 5_000);
  if (res.ok) return { ok: true, alreadyOn: false };
  return { ok: false, reason: res.stderr || `exit ${res.code ?? "unknown"}` };
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

  // Enable linger BEFORE enable --now so the unit can survive logout from
  // the very first session. Best-effort: if polkit denies it, surface a
  // warning with the manual recovery command rather than failing install.
  const lingerRes = tryEnableLinger();
  if (!lingerRes.ok) {
    print.line(
      `    warning: loginctl enable-linger failed: ${lingerRes.reason}\n` +
        `    The service will stop when you log out. Run manually: sudo loginctl enable-linger ${userInfo().username}\n`,
    );
  }

  const enableRes = runCapture("systemctl", ["--user", "enable", "--now", SYSTEMD_UNIT], 10_000);
  if (!enableRes.ok) {
    throw new Error(
      `systemctl --user enable --now ${SYSTEMD_UNIT} failed: ${enableRes.stderr || `exit ${enableRes.code ?? "unknown"}`}\n` +
        `    Recovery: \`systemctl --user stop ${SYSTEMD_UNIT}\` then \`first-tree-hub client connect <server-url>\`.`,
    );
  }

  const { state, pid, detail } = systemdState();
  return {
    platform: "systemd",
    label: SYSTEMD_UNIT,
    unitPath,
    logDir: LOG_DIR,
    state,
    pid,
    detail,
  };
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
    const { state, pid, detail } = launchdState();
    return {
      platform: "launchd",
      label: LAUNCHD_LABEL,
      unitPath: launchdPlistPath(),
      logDir: LOG_DIR,
      state,
      pid,
      detail,
    };
  }
  if (process.platform === "linux") {
    const { state, pid, detail } = systemdState();
    return {
      platform: "systemd",
      label: SYSTEMD_UNIT,
      unitPath: systemdUnitPath(),
      logDir: LOG_DIR,
      state,
      pid,
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

// ── start / stop / restart ──────────────────────────────────────────
//
// These delegate to the platform's service manager. Designed so the
// `client start / stop / restart` CLI commands are thin wrappers — all
// platform-specific quirks (launchctl bootout vs kickstart, systemctl
// start vs restart, "not loaded" tolerance) live here.

/** Start the service. No-op + ok if already running. */
export function startClientService(): ServiceOpResult {
  if (process.platform === "linux") {
    const res = runCapture("systemctl", ["--user", "start", SYSTEMD_UNIT], 15_000);
    if (!res.ok) return { ok: false, reason: res.stderr || `exit ${res.code ?? "unknown"}` };
    return { ok: true };
  }
  if (process.platform === "darwin") {
    const target = launchctlDomainTarget();
    const plistPath = launchdPlistPath();
    if (!existsSync(plistPath)) return { ok: false, reason: "service not installed" };
    // launchctl print returns 0 only when the label is registered. Use it
    // as the "already loaded?" probe — if loaded, kickstart bumps it back
    // to running; otherwise bootstrap loads the plist (which RunAtLoad's
    // it). Either path leaves us with a running service.
    const probe = runCaptureOut("launchctl", ["print", `${target}/${LAUNCHD_LABEL}`], 5_000);
    if (probe.ok) {
      const res = runCapture("launchctl", ["kickstart", `${target}/${LAUNCHD_LABEL}`], 10_000);
      if (!res.ok) return { ok: false, reason: res.stderr || `exit ${res.code ?? "unknown"}` };
      return { ok: true };
    }
    const res = runCapture("launchctl", ["bootstrap", target, plistPath], 10_000);
    if (!res.ok) return { ok: false, reason: res.stderr || `exit ${res.code ?? "unknown"}` };
    return { ok: true };
  }
  return { ok: false, reason: `service control not supported on ${process.platform}` };
}

/**
 * Stop the service without disabling auto-start on next boot/login.
 *
 * systemd: `systemctl --user stop` — unit stays enabled, so a reboot or
 * `client start` brings it back. Combined with `Restart=on-failure +
 * SuccessExitStatus=0` in the unit, the SIGTERM path actually terminates
 * (the bug `Restart=always` had: stop would be immediately undone).
 *
 * launchd: `launchctl bootout` — unloads the running registration but
 * leaves the plist in `~/Library/LaunchAgents/`, so the next user login
 * (or `client start`) reloads it.
 */
export function stopClientService(): ServiceOpResult {
  if (process.platform === "linux") {
    const res = runCapture("systemctl", ["--user", "stop", SYSTEMD_UNIT], 35_000);
    if (!res.ok) return { ok: false, reason: res.stderr || `exit ${res.code ?? "unknown"}` };
    return { ok: true };
  }
  if (process.platform === "darwin") {
    const target = launchctlDomainTarget();
    const res = runCapture("launchctl", ["bootout", `${target}/${LAUNCHD_LABEL}`], 30_000);
    if (!res.ok) {
      if (/not find|no such|not loaded/i.test(res.stderr)) return { ok: true, detail: "not running" };
      return { ok: false, reason: res.stderr || `exit ${res.code ?? "unknown"}` };
    }
    return { ok: true };
  }
  return { ok: false, reason: `service control not supported on ${process.platform}` };
}

/** Restart the service. Equivalent to stop + start, but uses the manager's atomic primitive. */
export function restartClientService(): ServiceOpResult {
  if (process.platform === "linux") {
    const res = runCapture("systemctl", ["--user", "restart", SYSTEMD_UNIT], 45_000);
    if (!res.ok) return { ok: false, reason: res.stderr || `exit ${res.code ?? "unknown"}` };
    return { ok: true };
  }
  if (process.platform === "darwin") {
    const target = launchctlDomainTarget();
    const plistPath = launchdPlistPath();
    if (!existsSync(plistPath)) return { ok: false, reason: "service not installed" };
    // `kickstart -k` does kill+restart when the label is loaded. If it isn't
    // loaded yet (cold restart after stop), fall through to bootstrap.
    const res = runCapture("launchctl", ["kickstart", "-k", `${target}/${LAUNCHD_LABEL}`], 30_000);
    if (res.ok) return { ok: true };
    const bootstrapRes = runCapture("launchctl", ["bootstrap", target, plistPath], 10_000);
    if (!bootstrapRes.ok) return { ok: false, reason: bootstrapRes.stderr || `exit ${bootstrapRes.code ?? "unknown"}` };
    return { ok: true };
  }
  return { ok: false, reason: `service control not supported on ${process.platform}` };
}

/** Uninstall the background service. No-op if not installed. */
export function uninstallClientService(): ServiceInfo {
  if (process.platform === "darwin") return uninstallLaunchd();
  if (process.platform === "linux") return uninstallSystemd();
  return getClientServiceStatus();
}
