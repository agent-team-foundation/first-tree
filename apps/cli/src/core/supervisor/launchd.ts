import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { defaultHome } from "@first-tree/shared/config";
import { channelConfig } from "../channel.js";
import { print } from "../output.js";
import {
  ensureLogDir,
  extractProxyFromPlist,
  launchdPathEnv,
  logDir,
  migrateBakedProxyEnv,
  readFileOrFlagDrift,
  resolveCliInvocation,
  runCapture,
  runCaptureOut,
  type ShellResult,
  shellQuote,
  sleepSync,
} from "./shared.js";
import type { ResolvedBinary, ServiceInfo, ServiceOpResult, ServiceState, SupervisorBackend } from "./types.js";

// Service identifiers derived from the binary's channel — see
// `packages/shared/src/channel/`. Every channel (dev / staging / prod)
// owns its own unit name / launchd label, so multiple daemons coexist
// without colliding on the same service identifier.
const LAUNCHD_LABEL = channelConfig.launchdLabel;
// Human-readable name for the launchd background item. macOS lists
// unsigned background items by the launched file's name (System Settings
// → Login Items & Extensions → "Allow in the Background"), so we launch
// the daemon through a wrapper script whose filename is this value —
// otherwise the list shows the raw `index.mjs`. systemd has no equivalent
// problem (the unit carries a `Description=`), so this is launchd-only.
const LAUNCHD_DISPLAY_NAME = channelConfig.displayName;

export function launchdPlistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

// Path of the launchd launcher script. Its basename is the name macOS
// shows in the background-items list, so it is the channel display name.
// Lives under the channel home so it is stable across reinstalls and
// isolated per channel (parallel installs don't collide).
export function launchdWrapperPath(): string {
  return join(defaultHome(), "service", LAUNCHD_DISPLAY_NAME);
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
  return launchdInfo(plistPath, state, pid, detail);
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
  return launchdInfo(plistPath, state, pid, detail);
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

function getLaunchdServiceStatus(): ServiceInfo {
  const { state, pid, detail } = launchdState();
  return launchdInfo(launchdPlistPath(), state, pid, detail);
}

function launchdInfo(unitPath: string, state: ServiceState, pid?: number, detail?: string): ServiceInfo {
  return {
    platform: "launchd",
    label: LAUNCHD_LABEL,
    unitPath,
    logDir: logDir(),
    state,
    pid,
    detail,
  };
}

/** Start the service. No-op + ok if already running. */
function startLaunchdService(): ServiceOpResult {
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

/**
 * Stop the service without disabling auto-start on next boot/login.
 *
 * launchd: `launchctl bootout` — unloads the running registration but
 * leaves the plist in `~/Library/LaunchAgents/`, so the next user login
 * (or `daemon start`) reloads it.
 */
function stopLaunchdService(): ServiceOpResult {
  const target = launchctlDomainTarget();
  const res = runCapture("launchctl", ["bootout", `${target}/${LAUNCHD_LABEL}`], 30_000);
  if (!res.ok) {
    if (/not find|no such|not loaded/i.test(res.stderr)) return { ok: true, detail: "not running" };
    return { ok: false, reason: res.stderr || `exit ${res.code ?? "unknown"}` };
  }
  return { ok: true };
}

/** Restart the service. Equivalent to stop + start, but uses the manager's atomic primitive. */
function restartLaunchdService(): ServiceOpResult {
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

export const launchdBackend: SupervisorBackend = {
  platform: "launchd",
  isSupported: () => true,
  install: installLaunchd,
  refreshForUpdate: refreshLaunchdUnitForUpdate,
  isUnitDriftDetected: launchdUnitDriftDetected,
  status: getLaunchdServiceStatus,
  start: startLaunchdService,
  stop: stopLaunchdService,
  restart: restartLaunchdService,
  uninstall: uninstallLaunchd,
};
