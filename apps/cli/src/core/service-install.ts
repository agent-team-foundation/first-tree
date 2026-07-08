import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { defaultHome } from "@first-tree/shared/config";
import { channelConfig } from "./channel.js";
import { daemonEnvPath } from "./daemon-env.js";
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
  // spawnSync returns status === null + signal === 'SIGTERM' on timeout.
  // Without this branch every timed-out launchctl/systemctl call surfaces
  // as "exit unknown", which is the most likely failure mode under load
  // (heavy WS connection counts make stop/restart take 30-45s).
  if (res.signal) {
    return { ok: false, stderr: `${program} timed out after ${timeoutMs}ms (signal=${res.signal})`, code: null };
  }
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
  if (res.signal) {
    return { ok: false, stderr: `${program} timed out after ${timeoutMs}ms (signal=${res.signal})`, code: null };
  }
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

// Service identifiers derived from the binary's channel — see
// `packages/shared/src/channel/`. Every channel (dev / staging / prod)
// owns its own unit name / launchd label, so multiple daemons coexist
// without colliding on the same service identifier.
const SYSTEMD_UNIT = channelConfig.serviceUnitFile;
const LAUNCHD_LABEL = channelConfig.launchdLabel;
// `SyslogIdentifier` is the bare service name without `.service`. The
// launchd label uses the same identifier convention (bare name), so we
// reuse it for both.
const SYSLOG_IDENT = channelConfig.launchdLabel;
// Human-readable name for the launchd background item. macOS lists
// unsigned background items by the launched file's name (System Settings
// → Login Items & Extensions → "Allow in the Background"), so we launch
// the daemon through a wrapper script whose filename is this value —
// otherwise the list shows the raw `index.mjs`. systemd has no equivalent
// problem (the unit carries a `Description=`), so this is launchd-only.
const LAUNCHD_DISPLAY_NAME = channelConfig.displayName;
const SYSTEMD_BASE_PATH = ["/usr/local/bin", "/usr/bin", "/bin"];
const LAUNCHD_BASE_PATH = ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin"];

// Function rather than const: see `channel-env.ts` history note. A
// top-level `const = join(defaultHome(), ...)` would lock at module
// load, re-introducing the bundle eval-order foot-gun that motivated
// the resolver's function-based redesign.
function logDir(): string {
  return join(defaultHome(), "logs");
}

// Path of the launchd launcher script. Its basename is the name macOS
// shows in the background-items list, so it is the channel display name.
// Lives under the channel home so it is stable across reinstalls and
// isolated per channel (parallel installs don't collide).
function launchdWrapperPath(): string {
  return join(defaultHome(), "service", LAUNCHD_DISPLAY_NAME);
}

function servicePathEnv(basePaths: readonly string[]): string {
  const seen = new Set<string>();
  const paths = [dirname(process.execPath), ...basePaths].filter((value) => {
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
  return paths.join(":");
}

function systemdPathEnv(): string {
  return servicePathEnv(SYSTEMD_BASE_PATH);
}

function launchdPathEnv(): string {
  return servicePathEnv(LAUNCHD_BASE_PATH);
}

// Proxy env keys scanned during the one-time upgrade migration below. Both
// lower- and upper-case forms exist because libcurl, git, OpenSSL, and various
// tools each prefer a different case. The service unit no longer bakes these in
// (see `migrateBakedProxyEnv`); the daemon reads the user-owned `daemon.env`
// instead — compatibility, not management.
const PROXY_ENV_KEYS = [
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
] as const;

function unescapeXml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

/** Lift proxy env vars baked into a previous launchd plist (pre-compat units). */
function extractProxyFromPlist(xml: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of PROXY_ENV_KEYS) {
    const match = xml.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`));
    if (match && match[1].length > 0) out[key] = unescapeXml(match[1]);
  }
  return out;
}

/** Lift proxy env vars baked into a previous systemd unit (pre-compat units). */
function extractProxyFromSystemd(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of PROXY_ENV_KEYS) {
    const match = text.match(new RegExp(`^Environment=${key}=(.*)$`, "m"));
    if (!match) continue;
    let value = match[1].trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    }
    if (value.length > 0) out[key] = value;
  }
  return out;
}

/**
 * One-time upgrade buffer. Service units built before the "compatible, not
 * managing" redesign baked the user's proxy env directly into the plist /
 * systemd unit, which then went stale and self-froze on auto-update. Now the
 * daemon reads proxy from the user-owned `daemon.env` instead, so a straight
 * re-render would silently drop a proxy the user is relying on.
 *
 * So when re-rendering: if `daemon.env` does not exist yet AND the previous
 * on-disk unit carried proxy vars, copy them across ONCE. After that the file
 * is the user's to edit or delete and First Tree never rewrites it. No previous
 * unit, no baked proxy, or an existing `daemon.env` → no-op. Best-effort: a
 * write failure must never block service install.
 */
function migrateBakedProxyEnv(proxy: Record<string, string>): void {
  if (Object.keys(proxy).length === 0) return;
  const envPath = daemonEnvPath();
  if (existsSync(envPath)) return; // the user already owns this file
  try {
    mkdirSync(dirname(envPath), { recursive: true, mode: 0o700 });
    const body = Object.entries(proxy)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n");
    writeFileSync(
      envPath,
      "# Migrated once by First Tree from the previous service unit's baked proxy env.\n" +
        "# This file is yours: edit or delete it freely. First Tree reads it on daemon\n" +
        "# start but never rewrites it.\n" +
        `${body}\n`,
      { mode: 0o600 },
    );
    print.line(`    migrated proxy env into ${envPath} (yours to edit henceforth)\n`);
  } catch {
    // Best-effort migration — surfacing nothing is better than aborting install.
  }
}

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
 * Multi-env world: every channel has its own bin name (`first-tree` /
 * `first-tree-staging` / `first-tree-dev`), so a PATH lookup against
 * `channelConfig.binName` cannot collide with another channel's install.
 *
 *   ① bin found on PATH — use the installed shim. For npm-installed
 *      packages (prod, staging) the shim is usually under /usr/local/bin
 *      or ~/.npm-global/bin; for dev it's typically a symlink under
 *      ~/.local/bin pointing at the in-tree dist. Either way, using the
 *      shim means a re-install / re-link atomically swaps the binary
 *      without rewriting the unit file.
 *
 *   ② bin NOT on PATH — pin to the running interpreter + script. Common
 *      for dev when `~/.local/bin` is not in the install-time shell's
 *      PATH. `process.argv[1]` is the .mjs file the user just ran (via
 *      symlink or absolute path), so this guarantees the service launches
 *      the same binary the operator invoked.
 */
export function resolveCliInvocation(): ResolvedBinary {
  const bin = whichBin(channelConfig.binName);
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
  mkdirSync(logDir(), { recursive: true, mode: 0o700 });
}

// ── launchd (macOS) ─────────────────────────────────────────────────

function launchdPlistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

/**
 * Build the launchd plist. `wrapperPath` is the launcher script
 * (`launchdWrapperPath()`) — launchd runs it as `ProgramArguments[0]`, and
 * its basename is what macOS shows in the background-items list. The script
 * itself `exec`s the resolved CLI invocation with the daemon args (see
 * `renderLaunchdWrapper`), so nothing else needs to be on the command line.
 */
export function renderPlist(wrapperPath: string): string {
  const programArgs: string[] = [wrapperPath];

  const argsXml = programArgs.map((a) => `    <string>${escapeXml(a)}</string>`).join("\n");
  // launchd's StandardOutPath / StandardErrorPath are the fallback sink — they
  // only catch bare stdout/stderr (crash messages, third-party spam) because
  // the client's own logger writes a rotating NDJSON file at `client.log`
  // via FIRST_TREE_SERVICE_MODE. Naming these `.stdout.log` / `.stderr.log`
  // keeps that role explicit for anyone inspecting the logs dir.
  const stdoutFallback = join(logDir(), "client.stdout.log");
  const stderrFallback = join(logDir(), "client.stderr.log");

  // Always pin FIRST_TREE_HOME into the plist. launchd strips the user's
  // shell env on `bootstrap`, so without this line the daemon falls back
  // to the channel's default home — usually the right answer, but ANY
  // env override the operator was using (e.g. `FIRST_TREE_HOME=/tmp/foo`
  // for a one-off test) silently disappears at service-install time and
  // their data ends up split between two homes. Embedding the resolved
  // home eliminates that drift.
  const homeEnvXml = `\n    <key>FIRST_TREE_HOME</key>\n    <string>${escapeXml(defaultHome())}</string>`;

  // launchd does not inherit the operator's interactive shell PATH. Put the
  // current Node directory first so npm-installed CLI shims and self-update
  // run under the same Node toolchain that installed/refreshed the service.
  const pathEnvXml = escapeXml(launchdPathEnv());

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
    <string>${pathEnvXml}</string>
    <key>FIRST_TREE_SERVICE_MODE</key>
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

/**
 * Render the launchd launcher script. launchd runs this file (its basename
 * is the macOS background-item display name); the script `exec`s the
 * resolved CLI invocation so the live process is the same node/CLI process
 * launchd would otherwise start directly (`exec` keeps the PID, so launchctl
 * start/stop/kickstart still target it). Regenerated on every install /
 * refresh — drift detection re-checks it, so a Node or install-path change
 * still triggers a reinstall even though the plist points at a stable path.
 */
export function renderLaunchdWrapper(invocation: ResolvedBinary): string {
  const command: string =
    invocation.kind === "bin"
      ? `${shellQuote(invocation.program)} daemon start --no-interactive`
      : `${shellQuote(invocation.program)} ${invocation.args.map(shellQuote).join(" ")} daemon start --no-interactive`;

  return `#!/bin/sh
# Launcher for the First Tree background service. Its filename is the name
# macOS shows in System Settings -> Login Items & Extensions. Generated by
# the CLI on install/refresh -- do not edit; changes are overwritten.
exec ${command}
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

function writeLaunchdServiceFiles(): { plistPath: string; wrapperPath: string } {
  const invocation = resolveCliInvocation();
  ensureLogDir();

  const plistPath = launchdPlistPath();
  // Upgrade buffer: lift any proxy env a prior version baked into the plist into
  // the user-owned daemon.env before we re-render a proxy-free plist (no-op when
  // there is no prior plist, no baked proxy, or a daemon.env already exists).
  if (existsSync(plistPath)) {
    migrateBakedProxyEnv(extractProxyFromPlist(readFileSync(plistPath, "utf-8")));
  }

  const wrapperPath = launchdWrapperPath();
  mkdirSync(dirname(wrapperPath), { recursive: true, mode: 0o700 });
  writeFileSync(wrapperPath, renderLaunchdWrapper(invocation), { mode: 0o755 });

  mkdirSync(dirname(plistPath), { recursive: true });
  writeFileSync(plistPath, renderPlist(wrapperPath), { mode: 0o644 });

  return { plistPath, wrapperPath };
}

function installLaunchd(): ServiceInfo {
  // Legacy unit auto-cleanup deliberately not done here. Pre-multi-env,
  // every channel's "legacy" was the prod-era `dev.first-tree.client`
  // label, and an `install` from any channel would have ripped down
  // whatever the user had running under that name — including a
  // PARALLEL install (e.g. installing dev while staging was still
  // mid-migration to multi-env). MIGRATION.md Phase 2 documents the
  // operator-driven `launchctl bootout` step instead; safer to make
  // the user type it once than to wipe a peer install silently.
  const { plistPath } = writeLaunchdServiceFiles();
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
  // The 10s budget is the worst case under heavy WS load; if we fall
  // through without eviction, surface a hint so the operator knows the
  // bootstrap retry below is doing real work (rather than papering over
  // a different failure).
  const evicted = waitForLabelEvicted(target, LAUNCHD_LABEL, 10_000);
  if (!evicted) {
    print.line("    warning: launchctl bootout still settling after 10s; bootstrap may need a retry\n");
  }

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
        `    Recovery: \`launchctl bootout ${target}/${LAUNCHD_LABEL}\` then \`${channelConfig.binName} login <code>\`.`,
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
    logDir: logDir(),
    state,
    pid,
    detail,
  };
}

function refreshLaunchdUnitForUpdate(): ServiceInfo {
  // Auto-update calls this from inside the currently supervised launchd job.
  // Calling installLaunchd() here would bootout the very label that owns this
  // process, killing the parent daemon before it can exit with the self-restart
  // code. The loaded plist already points at a stable wrapper path, so rewriting
  // the wrapper + plist on disk is enough for the next launchd restart to pick
  // up the new binary.
  const { plistPath } = writeLaunchdServiceFiles();
  const { state, pid, detail } = launchdState();
  return {
    platform: "launchd",
    label: LAUNCHD_LABEL,
    unitPath: plistPath,
    logDir: logDir(),
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
  const wrapperPath = launchdWrapperPath();
  if (existsSync(wrapperPath)) rmSync(wrapperPath);
  return {
    platform: "launchd",
    label: LAUNCHD_LABEL,
    unitPath: plistPath,
    logDir: logDir(),
    state: "not-installed",
  };
}

// ── systemd --user (Linux) ──────────────────────────────────────────

function systemdUnitPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(xdg, "systemd", "user", SYSTEMD_UNIT);
}

export function renderSystemdUnit(invocation: ResolvedBinary): string {
  const execStart: string =
    invocation.kind === "bin"
      ? `${shellQuote(invocation.program)} daemon start --no-interactive`
      : `${shellQuote(invocation.program)} ${invocation.args.map(shellQuote).join(" ")} daemon start --no-interactive`;

  // Always pin FIRST_TREE_HOME into the unit. Without this line, systemd's
  // launched process inherits only the user manager's env — FIRST_TREE_HOME
  // is unset and the process falls back to the channel default. Usually
  // identical to what the operator wants, but ANY env override (one-off
  // `FIRST_TREE_HOME=/tmp/foo` test) silently disappears when the unit
  // gets installed. Embedding the resolved home eliminates that drift.
  const homeEnv = `Environment=FIRST_TREE_HOME=${shellQuote(defaultHome())}\n`;
  // `systemd --user` does not inherit the operator's interactive shell PATH.
  // Put this CLI's Node directory first so npm/nvm-installed shebangs and
  // self-update use the same Node toolchain when supervised.
  const pathEnv = `Environment=PATH=${shellQuote(systemdPathEnv())}\n`;

  // Restart policy split:
  //   - on-failure  → operator-issued `systemctl stop` (clean exit 0) really stops.
  //   - SuccessExitStatus=0 makes that explicit.
  //   - RestartForceExitStatus=75 keeps the self-update path working: the
  //     UpdateManager exits 75 after `npm i -g`, systemd sees it as a
  //     "must restart" signal and brings up the new binary.
  // StartLimit* caps a crash storm (10 failures in 5 min → systemd holds back).
  // Normal client diagnostics go through the rotating NDJSON `client.log` when
  // FIRST_TREE_SERVICE_MODE=1; journald is only the supervisor fallback for
  // bare stdout/stderr (crashes, third-party spam).
  return `[Unit]
Description=First Tree Client
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
${pathEnv}Environment=FIRST_TREE_SERVICE_MODE=1
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
  // Legacy unit auto-cleanup deliberately not done here — same reason
  // as `installLaunchd` above. A blanket `disable --now` + `rm` of
  // a retired or sibling channel service unit would silently wipe a peer
  // staging/prod install that the
  // operator hasn't migrated yet. MIGRATION.md Phase 2 documents the
  // operator-driven `systemctl --user stop` + `rm` snippet instead.
  const invocation = resolveCliInvocation();
  ensureLogDir();
  const unitPath = systemdUnitPath();
  // Upgrade buffer: lift any proxy env a prior version baked into the unit into
  // the user-owned daemon.env before we re-render a proxy-free unit (no-op when
  // there is no prior unit, no baked proxy, or a daemon.env already exists).
  if (existsSync(unitPath)) {
    migrateBakedProxyEnv(extractProxyFromSystemd(readFileSync(unitPath, "utf-8")));
  }
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
        `    Recovery: \`systemctl --user stop ${SYSTEMD_UNIT}\` then \`${channelConfig.binName} login <code>\`.`,
    );
  }

  const { state, pid, detail } = systemdState();
  return {
    platform: "systemd",
    label: SYSTEMD_UNIT,
    unitPath,
    logDir: logDir(),
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
    logDir: logDir(),
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
      `Run \`${channelConfig.binName} daemon start\` manually to keep the computer online.`,
  );
}

/**
 * Rewrite the supervised unit for an in-daemon auto-update handoff.
 *
 * On launchd this deliberately avoids bootout/bootstrap: refresh-unit runs as
 * a child of the current daemon job, and unloading that label can terminate the
 * update handoff before the parent daemon exits with the restart signal.
 *
 * On systemd we keep the install path because the unit explicitly treats exit
 * 75 as restart-forced, and `enable --now` does not unload the running parent
 * process out from under the update callback.
 */
export function refreshClientServiceUnitForUpdate(): ServiceInfo {
  if (process.platform === "darwin") return refreshLaunchdUnitForUpdate();
  if (process.platform === "linux") return installSystemd();
  throw new Error(
    `Background service refresh is not supported on ${process.platform}. ` +
      `Run \`${channelConfig.binName} daemon start\` manually to keep the computer online.`,
  );
}

/**
 * Cheap idempotency probe used by `daemon refresh-unit`: render the unit
 * file the *current binary* would write and compare against what's on disk.
 *
 * `true`  → contents differ, the next CLI version invocation will read a
 *           stale unit and `installClientService()` SHOULD be called.
 * `false` → on-disk unit already matches (the common case for patch
 *           upgrades within the same CLI surface), no need to pay the
 *           bootout/bootstrap or daemon-reload + enable cost.
 *
 * Defensive: if the unit file is missing entirely, we treat that as "drift"
 * — the caller likely needs `installClientService()` to lay it down,
 * NOT a refresh skip. Errors during read also return `true` rather than
 * silently skipping, so a permission glitch can't ever stall the unit
 * behind a stale ExecStart.
 *
 * Returns `false` on unsupported platforms (Windows): there's no unit file
 * to refresh, so "no drift" is the honest answer.
 */
export function isServiceUnitDriftDetected(): boolean {
  if (process.platform === "darwin") return launchdUnitDriftDetected();
  if (process.platform === "linux") return systemdUnitDriftDetected();
  return false;
}

function launchdUnitDriftDetected(): boolean {
  const invocation = resolveCliInvocation();
  const wrapperPath = launchdWrapperPath();
  // Two files back the launchd service: the plist (points at the stable
  // wrapper path) and the wrapper (embeds the resolved Node/CLI invocation).
  // The plist rarely changes now, so the wrapper is what catches a Node
  // upgrade or install-path move — check both or auto-update would skip a
  // reinstall and keep launching a stale binary.
  const wrapperDrift = readFileOrFlagDrift(wrapperPath, renderLaunchdWrapper(invocation));
  const plistDrift = readFileOrFlagDrift(launchdPlistPath(), renderPlist(wrapperPath));
  return wrapperDrift || plistDrift;
}

function systemdUnitDriftDetected(): boolean {
  const invocation = resolveCliInvocation();
  const expected = renderSystemdUnit(invocation);
  return readFileOrFlagDrift(systemdUnitPath(), expected);
}

function readFileOrFlagDrift(path: string, expected: string): boolean {
  if (!existsSync(path)) return true;
  try {
    const actual = readFileSync(path, "utf-8");
    return actual !== expected;
  } catch {
    // Treat unreadable as drift — better to install than silently skip.
    return true;
  }
}

/** Report the current service state without modifying anything. */
export function getClientServiceStatus(): ServiceInfo {
  if (process.platform === "darwin") {
    const { state, pid, detail } = launchdState();
    return {
      platform: "launchd",
      label: LAUNCHD_LABEL,
      unitPath: launchdPlistPath(),
      logDir: logDir(),
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
      logDir: logDir(),
      state,
      pid,
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

// ── start / stop / restart ──────────────────────────────────────────
//
// These delegate to the platform's service manager. Designed so the
// `daemon start / stop / restart` CLI commands are thin wrappers — all
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
 * `daemon start` brings it back. Combined with `Restart=on-failure +
 * SuccessExitStatus=0` in the unit, the SIGTERM path actually terminates
 * (the bug `Restart=always` had: stop would be immediately undone).
 *
 * launchd: `launchctl bootout` — unloads the running registration but
 * leaves the plist in `~/Library/LaunchAgents/`, so the next user login
 * (or `daemon start`) reloads it.
 */
export function stopClientService(): ServiceOpResult {
  if (process.platform === "linux") {
    const res = runCapture("systemctl", ["--user", "stop", SYSTEMD_UNIT], 35_000);
    if (!res.ok) {
      // Mirror the launchd "stop on missing unit = ok" semantics below: a
      // concurrent `daemon stop` or a manual `systemctl --user disable` can
      // leave us racing systemd to a unit that's already gone. Without this
      // tolerance, the second caller sees a spurious failure.
      if (/not loaded|no such|unknown unit|not found/i.test(res.stderr)) return { ok: true, detail: "not running" };
      return { ok: false, reason: res.stderr || `exit ${res.code ?? "unknown"}` };
    }
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
