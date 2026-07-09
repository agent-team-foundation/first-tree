import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { defaultHome } from "@first-tree/shared/config";
import { channelConfig } from "../channel.js";
import {
  ensureLogDir,
  readFileOrFlagDrift,
  resolveCliInvocation,
  runCapture,
  runCaptureOut,
  sleepSync,
} from "./shared.js";
import type { ServiceInfo, ServiceOpResult, ServiceState, SupervisorBackend } from "./types.js";
import {
  clearWindowsSupervisorStopIntent,
  renderWindowsSupervisorCmd,
  renderWindowsSupervisorLauncherVbs,
  windowsSupervisorLauncherPath,
  windowsSupervisorLogPath,
  windowsSupervisorStopIntentPath,
  windowsSupervisorWrapperLogPath,
  windowsSupervisorWrapperPath,
  windowsTaskLeafName,
  windowsTaskName,
  windowsTaskPath,
  windowsTaskXmlPath,
  writeWindowsSupervisorStopIntent,
} from "./windows-supervisor.js";

type TaskRunState = "running" | "not-running" | "missing" | "unknown";

type RuntimeMarker = {
  version: 1;
  pid: number;
  clientId: string;
  home: string;
  mode: "foreground" | "service";
  createdAt: string;
};

type LiveServiceRuntimeMarker = {
  pid: number;
  clientId: string;
  createdAt: string;
};

type MarkerReadResult = { ok: true; markers: LiveServiceRuntimeMarker[] } | { ok: false; reason: string };

type WindowsProcessIdentity = {
  commandLine: string;
  creationTimeUtc: string;
  executablePath: string;
  name?: string;
  parentProcessId: number | null;
  processId: number;
};

type WindowsProcessIdentityResult =
  | { status: "present"; identity: WindowsProcessIdentity }
  | { status: "gone" }
  | { status: "unknown"; reason: string };

type RuntimeMarkerTrustResult = { trusted: true } | { trusted: false; gone?: boolean; reason: string };
type KillRuntimeMarkerResult =
  | { ok: true; detail?: string; killAttempted: boolean }
  | { ok: false; reason: string; killAttempted: boolean };
type TrustedMarkersForStopResult = { ok: true; markers: LiveServiceRuntimeMarker[] } | { ok: false; reason: string };
type SupervisorProcessListResult = { ok: true; processes: WindowsProcessIdentity[] } | { ok: false; reason: string };

const POWERSHELL_ARGS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"] as const;
const PID_REUSE_CREATION_TOLERANCE_MS = 5_000;
const UTF_16LE_BOM = "\uFEFF";

function windowsInfo(state: ServiceState, pid?: number, detail?: string): ServiceInfo {
  return {
    platform: "task-scheduler",
    label: windowsTaskName(),
    unitPath: windowsTaskXmlPath(),
    logDir: join(defaultHome(), "logs"),
    state,
    pid,
    detail,
  };
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function escapePowerShellSingleQuoted(value: string): string {
  return value.replace(/'/g, "''");
}

function windowsNativeFailureDetail(res: { stderr: string; code: number | null }): string {
  const stderr = res.stderr.trim();
  const fallback = `exit ${res.code ?? "unknown"}`;
  if (!stderr) return fallback;
  if (stderr.includes("\uFFFD")) {
    return `${fallback}; Windows returned localized stderr that could not be decoded as UTF-8`;
  }
  return stderr;
}

function currentWindowsUserId(): string {
  const domain = process.env.USERDOMAIN?.trim();
  const username = process.env.USERNAME?.trim() || userInfo().username;
  return domain && username ? `${domain}\\${username}` : username;
}

function windowsScriptHostPath(): string {
  const root = (process.env.SystemRoot?.trim() || "C:\\Windows").replace(/[\\/]+$/u, "");
  return `${root}\\System32\\wscript.exe`;
}

export function renderWindowsTaskXml(launcherPath: string, userId = currentWindowsUserId()): string {
  const taskName = `${channelConfig.displayName} Client`;
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Author>${escapeXml(userId)}</Author>
    <Description>${escapeXml(taskName)}</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${escapeXml(userId)}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${escapeXml(userId)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>false</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${escapeXml(windowsScriptHostPath())}</Command>
      <Arguments>${escapeXml(`"${launcherPath}"`)}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

function encodeWindowsTaskXml(xml: string): Buffer {
  return Buffer.from(`${UTF_16LE_BOM}${xml}`, "utf16le");
}

function readWindowsTaskXml(path: string): string {
  const xml = readFileSync(path, "utf16le");
  return xml.startsWith(UTF_16LE_BOM) ? xml.slice(1) : xml;
}

function readWindowsTaskXmlOrFlagDrift(path: string, expected: string): boolean {
  try {
    return readWindowsTaskXml(path) !== expected;
  } catch {
    return true;
  }
}

function writeWindowsSupervisorFiles(): { wrapperPath: string; xmlPath: string } {
  const invocation = resolveCliInvocation();
  ensureLogDir();
  mkdirSync(dirname(windowsSupervisorWrapperPath()), { recursive: true, mode: 0o700 });
  const wrapperPath = windowsSupervisorWrapperPath();
  const launcherPath = windowsSupervisorLauncherPath();
  const xmlPath = windowsTaskXmlPath();
  writeFileSync(wrapperPath, renderWindowsSupervisorCmd(invocation), { mode: 0o755 });
  writeFileSync(launcherPath, renderWindowsSupervisorLauncherVbs(wrapperPath), { mode: 0o755 });
  writeFileSync(xmlPath, encodeWindowsTaskXml(renderWindowsTaskXml(launcherPath)), { mode: 0o600 });
  return { wrapperPath, xmlPath };
}

function taskState(): { state: TaskRunState; detail?: string } {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$task = Get-ScheduledTask -TaskPath '${escapePowerShellSingleQuoted(windowsTaskPath())}' -TaskName '${escapePowerShellSingleQuoted(windowsTaskLeafName())}' -ErrorAction SilentlyContinue`,
    "if ($null -eq $task) { exit 3 }",
    "[Console]::Out.Write($task.State.ToString())",
  ].join("; ");
  const res = runCaptureOut("powershell.exe", [...POWERSHELL_ARGS, script], 5_000);
  if (res.ok) {
    const value = res.stdout.trim().toLowerCase();
    if (value === "running") return { state: "running", detail: "task running" };
    return { state: "not-running", detail: value ? `task state ${res.stdout.trim()}` : "task registered" };
  }
  if (res.code === 3) return { state: "missing" };

  const query = runCapture("schtasks.exe", ["/Query", "/TN", windowsTaskName()], 5_000);
  if (!query.ok) {
    const text = `${res.stderr}\n${query.stderr}`.trim();
    if (/cannot find|does not exist|not found/i.test(text)) return { state: "missing" };
    return { state: "unknown", detail: text || `powershell exit ${res.code ?? "unknown"}` };
  }
  return {
    state: "unknown",
    detail: res.stderr || `task exists but state query failed (exit ${res.code ?? "unknown"})`,
  };
}

function clientRuntimeMarkerDir(): string {
  return join(defaultHome(), "state", "client-runtimes");
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = typeof err === "object" && err !== null && "code" in err ? (err as { code?: unknown }).code : null;
    return code !== "ESRCH";
  }
}

function valueAsString(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function valueAsNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function parseWindowsProcessIdentity(stdout: string): WindowsProcessIdentity | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const processId = valueAsNumber(record.ProcessId);
  if (processId === null) return null;
  return {
    processId,
    parentProcessId: valueAsNumber(record.ParentProcessId),
    name: valueAsString(record.Name),
    commandLine: valueAsString(record.CommandLine),
    executablePath: valueAsString(record.ExecutablePath),
    creationTimeUtc: valueAsString(record.CreationTimeUtc),
  };
}

function parseWindowsProcessIdentityList(stdout: string): WindowsProcessIdentity[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  const records = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" ? [parsed] : null;
  if (!records) return null;
  const processes: WindowsProcessIdentity[] = [];
  for (const record of records) {
    const stdout = JSON.stringify(record);
    const identity = parseWindowsProcessIdentity(stdout);
    if (!identity) return null;
    processes.push(identity);
  }
  return processes;
}

function queryWindowsProcessIdentity(pid: number): WindowsProcessIdentityResult {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" -ErrorAction SilentlyContinue`,
    "if ($null -eq $p) { exit 3 }",
    "$creation = if ($null -eq $p.CreationDate) { $null } else { $p.CreationDate.ToUniversalTime().ToString('o') }",
    "$item = [PSCustomObject]@{ ProcessId = $p.ProcessId; ParentProcessId = $p.ParentProcessId; Name = $p.Name; CommandLine = $p.CommandLine; ExecutablePath = $p.ExecutablePath; CreationTimeUtc = $creation }",
    "[Console]::Out.Write(($item | ConvertTo-Json -Compress))",
  ].join("; ");
  const res = runCaptureOut("powershell.exe", [...POWERSHELL_ARGS, script], 5_000);
  if (!res.ok) {
    if (res.code === 3) return { status: "gone" };
    return { status: "unknown", reason: res.stderr || `powershell exit ${res.code ?? "unknown"}` };
  }
  const identity = parseWindowsProcessIdentity(res.stdout);
  if (!identity) return { status: "unknown", reason: "process query returned malformed JSON" };
  if (identity.processId !== pid) {
    return { status: "unknown", reason: `process query returned pid ${identity.processId} for pid ${pid}` };
  }
  return { status: "present", identity };
}

function listLiveWindowsSupervisorProcesses(): SupervisorProcessListResult {
  const needles = [windowsSupervisorLauncherPath(), windowsSupervisorWrapperPath()];
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$needles = @(${needles.map((needle) => `'${escapePowerShellSingleQuoted(needle)}'`).join(", ")})`,
    `$channel = '${escapePowerShellSingleQuoted(channelConfig.binName.toLowerCase())}'`,
    "$self = $PID",
    "$items = @(Get-CimInstance Win32_Process | Where-Object {",
    "  if ($_.ProcessId -eq $self) { $false } else {",
    "    $cmd = [string]$_.CommandLine;",
    "    $exe = [string]$_.ExecutablePath;",
    '    $text = "$cmd $exe";',
    "    $lower = $text.ToLowerInvariant();",
    "    $matchedPath = $false;",
    "    foreach ($needle in $needles) { if ($text.Contains($needle)) { $matchedPath = $true; break } }",
    "    $matchedPath -or ($lower.Contains($channel) -and $lower.Contains('daemon') -and $lower.Contains('supervise'))",
    "  }",
    "} | ForEach-Object {",
    "  $creation = if ($null -eq $_.CreationDate) { $null } else { $_.CreationDate.ToUniversalTime().ToString('o') }",
    "  [PSCustomObject]@{ ProcessId = $_.ProcessId; ParentProcessId = $_.ParentProcessId; Name = $_.Name; CommandLine = $_.CommandLine; ExecutablePath = $_.ExecutablePath; CreationTimeUtc = $creation }",
    "})",
    "[Console]::Out.Write(($items | ConvertTo-Json -Compress))",
  ].join("; ");
  const res = runCaptureOut("powershell.exe", [...POWERSHELL_ARGS, script], 5_000);
  if (!res.ok) {
    return { ok: false, reason: res.stderr || `powershell exit ${res.code ?? "unknown"}` };
  }
  if (!res.stdout.trim()) return { ok: true, processes: [] };
  const processes = parseWindowsProcessIdentityList(res.stdout);
  if (!processes) return { ok: false, reason: "supervisor process query returned malformed JSON" };
  return { ok: true, processes };
}

function summarizeSupervisorProcesses(processes: WindowsProcessIdentity[]): string {
  return processes
    .slice(0, 3)
    .map((process) => {
      const command = `${process.name ?? "process"} pid=${process.processId} ${process.commandLine}`.trim();
      return command.length > 180 ? `${command.slice(0, 180)}...` : command;
    })
    .join("; ");
}

function waitForNoWindowsSupervisorProcesses(timeoutMs: number): ServiceOpResult {
  const deadline = Date.now() + timeoutMs;
  let lastProcesses: WindowsProcessIdentity[] = [];
  while (Date.now() <= deadline) {
    const live = listLiveWindowsSupervisorProcesses();
    if (!live.ok) {
      return { ok: false, reason: `unable to verify supervisor process cleanup: ${live.reason}` };
    }
    if (live.processes.length === 0) return { ok: true };
    lastProcesses = live.processes;
    sleepSync(200);
  }
  return {
    ok: false,
    reason: `supervisor process still running after task end: ${summarizeSupervisorProcesses(lastProcesses)}`,
  };
}

function looksLikeFirstTreeDaemonStart(command: string): boolean {
  const normalized = command.replace(/\\/g, "/").toLowerCase();
  const tokens = normalized.match(/"[^"]*"|\S+/gu)?.map((token) => token.replace(/^"|"$/gu, "")) ?? [];
  const daemonIndex = tokens.indexOf("daemon");
  const startIndex = tokens.indexOf("start");
  if (daemonIndex < 0 || startIndex <= daemonIndex || !tokens.includes("--no-interactive")) return false;
  return (
    /(^|[/\s"])first-tree(?:-(?:dev|staging))?(?:\.(?:cmd|bat|exe|js|mjs|cjs|ts))?(?=$|[\s"])/u.test(normalized) ||
    /(?:^|[/\s"])(?:cli\/index|index)\.(?:mjs|cjs|js|ts)(?=$|[\s"])/u.test(normalized)
  );
}

function verifyRuntimeMarkerProcess(marker: LiveServiceRuntimeMarker): RuntimeMarkerTrustResult {
  const identity = queryWindowsProcessIdentity(marker.pid);
  if (identity.status === "gone") return { trusted: false, gone: true, reason: "already stopped" };
  if (identity.status === "unknown") return { trusted: false, reason: identity.reason };

  const command = `${identity.identity.commandLine} ${identity.identity.executablePath}`.trim();
  if (!looksLikeFirstTreeDaemonStart(command)) {
    const detail = command.length > 180 ? `${command.slice(0, 180)}...` : command || "empty command line";
    return { trusted: false, reason: `pid command does not match First Tree daemon start: ${detail}` };
  }

  const markerCreated = Date.parse(marker.createdAt);
  if (!Number.isFinite(markerCreated)) {
    return { trusted: false, reason: `runtime marker has invalid createdAt ${marker.createdAt}` };
  }
  const processCreated = Date.parse(identity.identity.creationTimeUtc);
  if (!Number.isFinite(processCreated)) {
    return { trusted: false, reason: "process creation time is unavailable" };
  }
  if (processCreated > markerCreated + PID_REUSE_CREATION_TOLERANCE_MS) {
    return {
      trusted: false,
      reason: `pid process was created after runtime marker (${identity.identity.creationTimeUtc} > ${marker.createdAt})`,
    };
  }

  return { trusted: true };
}

function listLiveServiceRuntimeMarkers(): MarkerReadResult {
  const markerDir = clientRuntimeMarkerDir();
  if (!existsSync(markerDir)) return { ok: true, markers: [] };
  let entries: string[];
  try {
    entries = readdirSync(markerDir);
  } catch (err) {
    return {
      ok: false,
      reason: `Unable to inspect runtime markers: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const markers: LiveServiceRuntimeMarker[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const path = join(markerDir, entry);
    let marker: RuntimeMarker;
    try {
      marker = JSON.parse(readFileSync(path, "utf8")) as RuntimeMarker;
    } catch (err) {
      return {
        ok: false,
        reason: `Unable to read runtime marker ${path}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (marker.version !== 1 || marker.home !== defaultHome() || marker.mode !== "service") continue;
    if (!isPidAlive(marker.pid)) {
      rmSync(path, { force: true });
      continue;
    }
    markers.push({ pid: marker.pid, clientId: marker.clientId, createdAt: marker.createdAt });
  }
  return { ok: true, markers };
}

function statusFromTaskAndMarkers(): ServiceInfo {
  const task = taskState();
  const markers = listLiveServiceRuntimeMarkers();
  if (!markers.ok) return windowsInfo("unknown", undefined, markers.reason);

  const residual =
    markers.markers.length === 0 && (task.state === "missing" || task.state === "not-running")
      ? listLiveWindowsSupervisorProcesses()
      : { ok: true as const, processes: [] };
  if (!residual.ok) return windowsInfo("unknown", undefined, residual.reason);

  if (task.state === "missing") {
    if (markers.markers.length > 0) {
      return windowsInfo("unknown", undefined, "task missing but service runtime marker is live");
    }
    if (residual.processes.length > 0) {
      return windowsInfo("unknown", undefined, "task missing but supervisor process is still live");
    }
    return windowsInfo("not-installed");
  }

  if (task.state === "unknown") {
    return windowsInfo("unknown", undefined, task.detail ?? "task state unavailable");
  }

  if (task.state === "running") {
    if (markers.markers.length === 1) {
      const marker = markers.markers[0];
      return windowsInfo("active", marker.pid, `pid ${marker.pid}`);
    }
    if (markers.markers.length > 1) {
      return windowsInfo("unknown", undefined, `task running with ${markers.markers.length} live service markers`);
    }
    return windowsInfo("unknown", undefined, "task running but no live service runtime marker");
  }

  if (markers.markers.length > 0) {
    return windowsInfo("unknown", undefined, "task not running but service runtime marker is live");
  }
  if (residual.processes.length > 0) {
    return windowsInfo("unknown", undefined, "task not running but supervisor process is still live");
  }
  return windowsInfo("inactive", undefined, task.detail ?? "task registered");
}

function createOrUpdateTask(xmlPath: string): void {
  const res = runCapture("schtasks.exe", ["/Create", "/TN", windowsTaskName(), "/XML", xmlPath, "/F"], 10_000);
  if (!res.ok) {
    throw new Error(`schtasks /Create failed: ${windowsNativeFailureDetail(res)}`);
  }
}

function runTask(): ServiceOpResult {
  const res = runCapture("schtasks.exe", ["/Run", "/TN", windowsTaskName()], 10_000);
  if (!res.ok) return { ok: false, reason: windowsNativeFailureDetail(res) };
  return { ok: true };
}

function endTask(): ServiceOpResult {
  const res = runCapture("schtasks.exe", ["/End", "/TN", windowsTaskName()], 10_000);
  if (!res.ok) {
    if (/not currently running|is not running|cannot find|does not exist|not found/i.test(res.stderr)) {
      return { ok: true, detail: "not running" };
    }
    return { ok: false, reason: windowsNativeFailureDetail(res) };
  }
  return { ok: true };
}

function waitForPidExit(pid: number, timeoutMs: number): boolean {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    sleepSync(200);
  }
  return !isPidAlive(pid);
}

function killRuntimeMarker(marker: LiveServiceRuntimeMarker): KillRuntimeMarkerResult {
  if (!isPidAlive(marker.pid)) return { ok: true, detail: "already stopped", killAttempted: false };
  const trusted = verifyRuntimeMarkerProcess(marker);
  if (!trusted.trusted) {
    if (trusted.gone) return { ok: true, detail: "already stopped", killAttempted: false };
    return {
      ok: false,
      reason: `refusing to taskkill untrusted service runtime marker pid ${marker.pid}: ${trusted.reason}`,
      killAttempted: false,
    };
  }
  const graceful = runCapture("taskkill.exe", ["/PID", String(marker.pid), "/T"], 10_000);
  if (waitForPidExit(marker.pid, graceful.ok ? 5_000 : 0)) return { ok: true, killAttempted: true };

  const forced = runCapture("taskkill.exe", ["/PID", String(marker.pid), "/T", "/F"], 10_000);
  if (waitForPidExit(marker.pid, forced.ok ? 5_000 : 0)) return { ok: true, killAttempted: true };
  if (!forced.ok) {
    return { ok: false, reason: windowsNativeFailureDetail(forced), killAttempted: true };
  }
  return { ok: false, reason: `pid ${marker.pid} did not exit after taskkill /F`, killAttempted: true };
}

function trustedMarkersForStop(markers: LiveServiceRuntimeMarker[]): TrustedMarkersForStopResult {
  const trustedMarkers: LiveServiceRuntimeMarker[] = [];
  for (const marker of markers) {
    if (!isPidAlive(marker.pid)) continue;
    const trusted = verifyRuntimeMarkerProcess(marker);
    if (!trusted.trusted) {
      if (trusted.gone) continue;
      return {
        ok: false,
        reason: `refusing to taskkill untrusted service runtime marker pid ${marker.pid}: ${trusted.reason}`,
      };
    }
    trustedMarkers.push(marker);
  }
  return { ok: true, markers: trustedMarkers };
}

function installWindowsTaskScheduler(): ServiceInfo {
  const { xmlPath } = writeWindowsSupervisorFiles();
  clearWindowsSupervisorStopIntent();
  createOrUpdateTask(xmlPath);
  const run = runTask();
  if (!run.ok) throw new Error(`schtasks /Run failed: ${run.reason}`);
  return windowsInfo("active", undefined, "task run requested");
}

function refreshWindowsTaskSchedulerForUpdate(): ServiceInfo {
  const { xmlPath } = writeWindowsSupervisorFiles();
  createOrUpdateTask(xmlPath);
  return statusFromTaskAndMarkers();
}

function windowsTaskSchedulerDriftDetected(): boolean {
  const invocation = resolveCliInvocation();
  const wrapperPath = windowsSupervisorWrapperPath();
  const launcherPath = windowsSupervisorLauncherPath();
  const wrapperDrift = readFileOrFlagDrift(wrapperPath, renderWindowsSupervisorCmd(invocation));
  const launcherDrift = readFileOrFlagDrift(launcherPath, renderWindowsSupervisorLauncherVbs(wrapperPath));
  const xmlDrift = readWindowsTaskXmlOrFlagDrift(windowsTaskXmlPath(), renderWindowsTaskXml(launcherPath));
  const taskMissing = taskState().state === "missing";
  return taskMissing || wrapperDrift || launcherDrift || xmlDrift;
}

function startWindowsTaskSchedulerService(): ServiceOpResult {
  const task = taskState();
  if (task.state === "missing") return { ok: false, reason: "service not installed" };
  if (task.state === "running") return { ok: true, detail: "already running" };
  if (task.state === "unknown") return { ok: false, reason: task.detail ?? "task state unavailable" };
  const markers = listLiveServiceRuntimeMarkers();
  if (!markers.ok) return { ok: false, reason: markers.reason };
  if (markers.markers.length > 0) {
    return {
      ok: false,
      reason: "service runtime marker is live without a running task; run daemon stop before starting again",
    };
  }
  const residual = listLiveWindowsSupervisorProcesses();
  if (!residual.ok) return { ok: false, reason: residual.reason };
  if (residual.processes.length > 0) {
    return {
      ok: false,
      reason: "supervisor process is live without a running task; run daemon stop and wait before starting again",
    };
  }
  clearWindowsSupervisorStopIntent();
  return runTask();
}

function stopWindowsTaskSchedulerService(): ServiceOpResult {
  const task = taskState();
  if (task.state === "missing") {
    const residual = listLiveWindowsSupervisorProcesses();
    if (!residual.ok) return { ok: false, reason: residual.reason };
    if (residual.processes.length > 0) {
      writeWindowsSupervisorStopIntent();
      const stopped = waitForNoWindowsSupervisorProcesses(5_000);
      if (!stopped.ok) return stopped;
    }
    clearWindowsSupervisorStopIntent();
    return { ok: true, detail: "not running" };
  }
  if (task.state === "unknown") return { ok: false, reason: task.detail ?? "task state unavailable" };

  const markers = listLiveServiceRuntimeMarkers();
  if (!markers.ok) {
    return { ok: false, reason: markers.reason };
  }
  const trustedMarkers = trustedMarkersForStop(markers.markers);
  if (!trustedMarkers.ok) return trustedMarkers;

  writeWindowsSupervisorStopIntent();
  let anyKillAttempted = false;
  for (const marker of trustedMarkers.markers ?? []) {
    const killed = killRuntimeMarker(marker);
    anyKillAttempted ||= killed.killAttempted;
    if (!killed.ok) {
      if (!anyKillAttempted) clearWindowsSupervisorStopIntent();
      return { ok: false, reason: killed.reason };
    }
  }

  const end = task.state === "running" ? endTask() : { ok: true as const, detail: "not running" };
  if (!end.ok) return end;
  const after = taskState();
  if (after.state === "running" || after.state === "unknown") {
    return {
      ok: false,
      reason: after.detail ? `task did not stop: ${after.detail}` : "task did not stop",
    };
  }

  const residual = waitForNoWindowsSupervisorProcesses(5_000);
  if (!residual.ok) return residual;
  clearWindowsSupervisorStopIntent();

  if (task.state === "running" && markers.markers.length === 0) {
    return {
      ok: true,
      detail: "task ended without a runtime marker; check Task Manager for any residual first-tree process",
    };
  }
  return { ok: true };
}

function restartWindowsTaskSchedulerService(): ServiceOpResult {
  const stopped = stopWindowsTaskSchedulerService();
  if (!stopped.ok) return stopped;
  return startWindowsTaskSchedulerService();
}

function uninstallWindowsTaskScheduler(): ServiceInfo {
  const stopped = stopWindowsTaskSchedulerService();
  if (!stopped.ok) {
    // Continue deleting the task definition, but preserve the warning in
    // status detail rather than leaving an installed task behind forever.
  }
  const res = runCapture("schtasks.exe", ["/Delete", "/TN", windowsTaskName(), "/F"], 10_000);
  if (!res.ok && !/cannot find|does not exist|not found/i.test(res.stderr)) {
    throw new Error(`schtasks /Delete failed: ${windowsNativeFailureDetail(res)}`);
  }
  rmSync(windowsSupervisorWrapperPath(), { force: true });
  rmSync(windowsSupervisorLauncherPath(), { force: true });
  rmSync(windowsTaskXmlPath(), { force: true });
  rmSync(windowsSupervisorStopIntentPath(), { force: true });
  return windowsInfo("not-installed", undefined, stopped.ok ? undefined : stopped.reason);
}

export const taskSchedulerBackend: SupervisorBackend = {
  platform: "task-scheduler",
  isSupported: () => true,
  install: installWindowsTaskScheduler,
  refreshForUpdate: refreshWindowsTaskSchedulerForUpdate,
  isUnitDriftDetected: windowsTaskSchedulerDriftDetected,
  status: statusFromTaskAndMarkers,
  start: startWindowsTaskSchedulerService,
  stop: stopWindowsTaskSchedulerService,
  restart: restartWindowsTaskSchedulerService,
  uninstall: uninstallWindowsTaskScheduler,
};

export {
  renderWindowsSupervisorCmd,
  renderWindowsSupervisorLauncherVbs,
  windowsSupervisorLauncherPath,
  windowsSupervisorLogPath,
  windowsSupervisorWrapperLogPath,
  windowsSupervisorWrapperPath,
  windowsTaskName,
  windowsTaskXmlPath,
};
