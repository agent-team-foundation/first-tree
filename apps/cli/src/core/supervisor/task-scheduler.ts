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
  windowsSupervisorLogPath,
  windowsSupervisorStopIntentPath,
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
};

type MarkerReadResult = { ok: true; markers: LiveServiceRuntimeMarker[] } | { ok: false; reason: string };

const POWERSHELL_ARGS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"] as const;

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

function currentWindowsUserId(): string {
  const domain = process.env.USERDOMAIN?.trim();
  const username = process.env.USERNAME?.trim() || userInfo().username;
  return domain && username ? `${domain}\\${username}` : username;
}

export function renderWindowsTaskXml(wrapperPath: string, userId = currentWindowsUserId()): string {
  const taskName = `${channelConfig.displayName} Client`;
  return `<?xml version="1.0" encoding="UTF-8"?>
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
      <Command>${escapeXml(wrapperPath)}</Command>
    </Exec>
  </Actions>
</Task>
`;
}

function writeWindowsSupervisorFiles(): { wrapperPath: string; xmlPath: string } {
  const invocation = resolveCliInvocation();
  ensureLogDir();
  mkdirSync(dirname(windowsSupervisorWrapperPath()), { recursive: true, mode: 0o700 });
  const wrapperPath = windowsSupervisorWrapperPath();
  const xmlPath = windowsTaskXmlPath();
  writeFileSync(wrapperPath, renderWindowsSupervisorCmd(invocation), { mode: 0o755 });
  writeFileSync(xmlPath, renderWindowsTaskXml(wrapperPath), { mode: 0o600 });
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
    markers.push({ pid: marker.pid, clientId: marker.clientId });
  }
  return { ok: true, markers };
}

function statusFromTaskAndMarkers(): ServiceInfo {
  const task = taskState();
  const markers = listLiveServiceRuntimeMarkers();
  if (!markers.ok) return windowsInfo("unknown", undefined, markers.reason);

  if (task.state === "missing") {
    if (markers.markers.length > 0) {
      return windowsInfo("unknown", undefined, "task missing but service runtime marker is live");
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
  return windowsInfo("inactive", undefined, task.detail ?? "task registered");
}

function createOrUpdateTask(xmlPath: string): void {
  const res = runCapture("schtasks.exe", ["/Create", "/TN", windowsTaskName(), "/XML", xmlPath, "/F"], 10_000);
  if (!res.ok) {
    throw new Error(`schtasks /Create failed: ${res.stderr || `exit ${res.code ?? "unknown"}`}`);
  }
}

function runTask(): ServiceOpResult {
  const res = runCapture("schtasks.exe", ["/Run", "/TN", windowsTaskName()], 10_000);
  if (!res.ok) return { ok: false, reason: res.stderr || `exit ${res.code ?? "unknown"}` };
  return { ok: true };
}

function endTask(): ServiceOpResult {
  const res = runCapture("schtasks.exe", ["/End", "/TN", windowsTaskName()], 10_000);
  if (!res.ok) {
    if (/not currently running|is not running|cannot find|does not exist|not found/i.test(res.stderr)) {
      return { ok: true, detail: "not running" };
    }
    return { ok: false, reason: res.stderr || `exit ${res.code ?? "unknown"}` };
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

function killRuntimeMarker(marker: LiveServiceRuntimeMarker): ServiceOpResult {
  if (!isPidAlive(marker.pid)) return { ok: true, detail: "already stopped" };
  const graceful = runCapture("taskkill.exe", ["/PID", String(marker.pid), "/T"], 10_000);
  if (waitForPidExit(marker.pid, graceful.ok ? 5_000 : 0)) return { ok: true };

  const forced = runCapture("taskkill.exe", ["/PID", String(marker.pid), "/T", "/F"], 10_000);
  if (waitForPidExit(marker.pid, forced.ok ? 5_000 : 0)) return { ok: true };
  if (!forced.ok) {
    return { ok: false, reason: forced.stderr || `taskkill /F exit ${forced.code ?? "unknown"}` };
  }
  return { ok: false, reason: `pid ${marker.pid} did not exit after taskkill /F` };
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
  const wrapperDrift = readFileOrFlagDrift(wrapperPath, renderWindowsSupervisorCmd(invocation));
  const xmlDrift = readFileOrFlagDrift(windowsTaskXmlPath(), renderWindowsTaskXml(wrapperPath));
  const taskMissing = taskState().state === "missing";
  return taskMissing || wrapperDrift || xmlDrift;
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
  clearWindowsSupervisorStopIntent();
  return runTask();
}

function stopWindowsTaskSchedulerService(): ServiceOpResult {
  const task = taskState();
  if (task.state === "missing") {
    clearWindowsSupervisorStopIntent();
    return { ok: true, detail: "not running" };
  }
  if (task.state === "unknown") return { ok: false, reason: task.detail ?? "task state unavailable" };

  writeWindowsSupervisorStopIntent();
  const markers = listLiveServiceRuntimeMarkers();
  if (!markers.ok) {
    clearWindowsSupervisorStopIntent();
    return { ok: false, reason: markers.reason };
  }
  for (const marker of markers.markers) {
    const killed = killRuntimeMarker(marker);
    if (!killed.ok) return killed;
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
    throw new Error(`schtasks /Delete failed: ${res.stderr || `exit ${res.code ?? "unknown"}`}`);
  }
  rmSync(windowsSupervisorWrapperPath(), { force: true });
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
  windowsSupervisorLogPath,
  windowsSupervisorWrapperPath,
  windowsTaskName,
  windowsTaskXmlPath,
};
