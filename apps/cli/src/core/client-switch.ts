import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { ClientConfig } from "@first-tree/shared/config";
import {
  clientConfigSchema,
  defaultConfigDir,
  defaultDataDir,
  defaultHome,
  initConfig,
  readConfigFile,
  resetConfig,
  resetConfigMeta,
  setConfigValue,
} from "@first-tree/shared/config";
import { confirm } from "@inquirer/prompts";
import { fail } from "../cli/output.js";
import { saveCredentials } from "./bootstrap.js";
import { channelConfig } from "./channel.js";
import { print } from "./output.js";
import { getClientServiceStatus, stopClientService } from "./service-install.js";

type StoredCredentials = {
  accessToken: string;
  refreshToken: string;
  serverUrl: string;
};

type SwitchIndexEntry = {
  clientId: string;
  userId: string;
  serverUrl: string;
  storage: "active-root" | "parked";
  parkedPath?: string;
  updatedAt: string;
};

type SwitchIndex = {
  version: 1;
  activeClientId?: string;
  accountDefaults: Record<string, string>;
  clients: Record<string, SwitchIndexEntry>;
};

export type LocalClientOwner = {
  clientId: string;
  userId: string;
  serverUrl: string;
};

type SwitchMoveState = "pending" | "done" | "absent" | "create";

type SwitchMoveGroup = "park" | "restore";

type SwitchMoveKind =
  | "park-client-yaml"
  | "park-agents"
  | "park-sessions"
  | "park-workspaces"
  | "restore-client-yaml"
  | "restore-agents"
  | "restore-sessions"
  | "restore-workspaces";

type SwitchJournalMove = {
  kind: SwitchMoveKind;
  group: SwitchMoveGroup;
  source: string;
  target: string;
  required: boolean;
  state: SwitchMoveState;
  updatedAt?: string;
};

type SwitchJournal = {
  version: 1;
  id: string;
  phase:
    | "locked"
    | "service-stopped"
    | "drain-clean"
    | "parked-old-client"
    | "restored-target-client"
    | "credentials-written"
    | "complete";
  from: {
    clientId: string;
    userId: string;
    serverUrl: string;
  };
  to: {
    clientId?: string;
    userId: string;
    serverUrl: string;
  };
  moves?: SwitchJournalMove[];
  createdAt: string;
  updatedAt: string;
};

type MarkedProviderProcess = {
  pid: number;
  provider: string;
  agentId?: string;
  chatId?: string;
  command: string;
};

type ProviderMarkerIssue = {
  pid: number;
  command: string;
  reason: string;
};

type RuntimeMarker = {
  version: 1;
  pid: number;
  clientId: string;
  home: string;
  mode: "foreground" | "service";
  createdAt: string;
};

export type LiveRuntimeMarker = {
  pid: number;
  clientId: string;
  mode: RuntimeMarker["mode"];
  command?: string;
};

export type StopClientRuntimeProcessResult = { ok: true; alreadyStopped?: boolean } | { ok: false; reason: string };

type DrainSnapshot =
  | { ok: true; providers: MarkedProviderProcess[] }
  | { ok: false; code: "CLIENT_SWITCH_DRAIN_UNSUPPORTED"; reason: string };

const SWITCH_DRAIN_VERSION = "1";
export const CLIENT_SWITCH_INTERRUPTED_REASON = "client_switch_interrupted";

class ClientSwitchCommandError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
    this.name = "ClientSwitchCommandError";
  }
}

export function clientSwitchLockPath(home = defaultHome()): string {
  return join(home, "state", "client-switch.lock");
}

export function clientSwitchJournalPath(home = defaultHome()): string {
  return join(home, "state", "client-switch-journal.json");
}

export function clientRuntimeMarkerPath(home = defaultHome(), pid = process.pid): string {
  return join(home, "state", "client-runtimes", `${pid}.json`);
}

export function registerClientRuntimeMarker(opts: {
  clientId: string;
  mode: RuntimeMarker["mode"];
  home?: string;
  pid?: number;
}): () => void {
  const home = opts.home ?? defaultHome();
  const pid = opts.pid ?? process.pid;
  const marker: RuntimeMarker = {
    version: 1,
    pid,
    clientId: opts.clientId,
    home,
    mode: opts.mode,
    createdAt: new Date().toISOString(),
  };
  writeJsonAtomic(clientRuntimeMarkerPath(home, pid), marker);
  let cleared = false;
  return () => {
    if (cleared) return;
    cleared = true;
    rmSync(clientRuntimeMarkerPath(home, pid), { force: true });
  };
}

export function listLiveClientRuntimeMarkers(home = defaultHome(), clientId?: string): LiveRuntimeMarker[] {
  const markerDir = dirname(clientRuntimeMarkerPath(home, 0));
  if (!existsSync(markerDir)) return [];
  const live: LiveRuntimeMarker[] = [];
  let entries: string[];
  try {
    entries = readdirSync(markerDir);
  } catch (err) {
    throwSwitchFailure(
      "CLIENT_SWITCH_RUNTIME_MARKER_UNTRUSTED",
      `Unable to inspect runtime markers: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const markerPath = join(markerDir, entry);
    let marker: RuntimeMarker;
    try {
      marker = JSON.parse(readFileSync(markerPath, "utf8")) as RuntimeMarker;
    } catch (err) {
      throwSwitchFailure(
        "CLIENT_SWITCH_RUNTIME_MARKER_UNTRUSTED",
        `Unable to read runtime marker ${markerPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (marker.version !== 1 || marker.home !== home || (clientId && marker.clientId !== clientId)) continue;
    if (!isPidAlive(marker.pid)) {
      rmSync(markerPath, { force: true });
      continue;
    }
    live.push({
      pid: marker.pid,
      clientId: marker.clientId,
      mode: marker.mode,
      command: readPidCommand(marker.pid) ?? undefined,
    });
  }
  return live;
}

export async function stopClientRuntimeProcess(
  pid: number,
  opts: { signal?: NodeJS.Signals; timeoutMs?: number; intervalMs?: number } = {},
): Promise<StopClientRuntimeProcessResult> {
  if (!Number.isInteger(pid) || pid <= 0) return { ok: true, alreadyStopped: true };
  if (pid === process.pid) return { ok: false, reason: "refusing to stop the current CLI process" };
  if (!isPidAlive(pid)) return { ok: true, alreadyStopped: true };

  try {
    process.kill(pid, opts.signal ?? "SIGTERM");
  } catch (err) {
    const code = typeof err === "object" && err !== null && "code" in err ? (err as { code?: unknown }).code : null;
    if (code === "ESRCH") return { ok: true, alreadyStopped: true };
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }

  const timeoutMs = opts.timeoutMs ?? 5_000;
  const intervalMs = opts.intervalMs ?? 100;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return { ok: true };
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  if (!isPidAlive(pid)) return { ok: true };
  return { ok: false, reason: `timed out waiting for pid ${pid} to stop after ${timeoutMs}ms` };
}

export function getClientSwitchStartupBlock(home = defaultHome()): { lockPath: string; journalPath: string } | null {
  const lockPath = clientSwitchLockPath(home);
  const journalPath = clientSwitchJournalPath(home);
  if (existsSync(lockPath) || existsSync(journalPath)) return { lockPath, journalPath };
  return null;
}

export function resolveClientRuntimeStopReason(home = defaultHome()): string | undefined {
  return getClientSwitchStartupBlock(home) ? CLIENT_SWITCH_INTERRUPTED_REASON : undefined;
}

export function readActiveRootClientId(configDir = defaultConfigDir()): string | null {
  return readRootClientId(configDir);
}

export function readActiveClientIdFromIndex(home = defaultHome()): string | null {
  const index = readSwitchIndex(home);
  const clientId = index.activeClientId;
  if (!clientId || !/^client_[a-f0-9]{8}$/.test(clientId)) return null;
  const entry = index.clients[clientId];
  return entry?.clientId === clientId && entry.storage === "active-root" ? clientId : null;
}

export function ensureActiveRootClientIdPersisted(clientId: string, configDir = defaultConfigDir()): void {
  if (!/^client_[a-f0-9]{8}$/.test(clientId)) return;
  const current = readRootClientId(configDir);
  if (current === clientId) return;
  if (current) return;
  setConfigValue(join(configDir, "client.yaml"), "client.id", clientId);
}

export function readActiveClientOwner(home = defaultHome(), configDir = defaultConfigDir()): LocalClientOwner | null {
  const clientId = readRootClientId(configDir);
  if (!clientId) return null;
  const entry = readSwitchIndex(home).clients[clientId];
  if (!entry || entry.storage !== "active-root") return null;
  return { clientId, userId: entry.userId, serverUrl: entry.serverUrl };
}

export function readRememberedLocalClientIdForAccount(
  serverUrl: string,
  userId: string,
  home = defaultHome(),
): string | null {
  return readSwitchIndex(home).accountDefaults[accountKey(serverUrl, userId)] ?? null;
}

export function hasIncompleteClientSwitch(home = defaultHome()): boolean {
  const journal = readJournal(home);
  return !!journal && journal.phase !== "complete";
}

export function recordActiveClientOwner(owner: LocalClientOwner, home = defaultHome()): void {
  const now = new Date().toISOString();
  const index = readSwitchIndex(home);
  for (const entry of Object.values(index.clients)) {
    if (entry.clientId !== owner.clientId && entry.storage === "active-root") {
      entry.storage = "parked";
      entry.parkedPath = parkedClientRoot(home, entry.clientId);
      entry.updatedAt = now;
    }
  }
  index.clients[owner.clientId] = {
    clientId: owner.clientId,
    userId: owner.userId,
    serverUrl: owner.serverUrl,
    storage: "active-root",
    updatedAt: now,
  };
  index.accountDefaults[accountKey(owner.serverUrl, owner.userId)] = owner.clientId;
  index.activeClientId = owner.clientId;
  writeJsonAtomic(indexPath(home), index);
}

export async function confirmLocalClientSwitch(opts: {
  existingServerUrl: string;
  targetServerUrl: string;
  existingUserId?: string;
  targetUserId?: string;
  existingClientId?: string;
  targetClientId?: string;
  forceSwitch?: boolean;
}): Promise<void> {
  if (opts.forceSwitch === true) return;
  if (process.stdin.isTTY !== true) {
    fail(
      "ACCOUNT_SWITCH_REQUIRES_CONFIRMATION",
      "This connect code belongs to a different First Tree user. Re-run with `--force-switch` in non-interactive mode to confirm account switching. Safety checks still run and cannot be skipped.",
      1,
    );
  }
  const ok = await confirm({
    message: formatSwitchConfirmationMessage(opts),
    default: false,
  });
  if (!ok) {
    fail("ACCOUNT_SWITCH_CANCELLED", "Account switch cancelled before changing local state.", 1);
  }
  if (opts.existingServerUrl !== opts.targetServerUrl) {
    // Keep the cross-server case explicit in the console transcript. It is
    // allowed, but it changes the account lookup key as well as the user id.
    print.line(`  Switching server: ${opts.existingServerUrl} -> ${opts.targetServerUrl}\n`);
  }
}

export async function switchLocalClientForLogin(opts: {
  existingCredentials?: StoredCredentials;
  previousOwnerSub?: string;
  targetTokens: StoredCredentials;
  targetOwnerSub: string;
}): Promise<ClientConfig> {
  const home = defaultHome();
  const configDir = defaultConfigDir();
  const dataDir = defaultDataDir();
  const pendingJournal = readJournal(home);
  if (pendingJournal?.phase === "complete") clearSwitchLock(home);
  else if (pendingJournal) {
    return completePendingSwitchForLogin({ home, configDir, journal: pendingJournal, opts });
  }

  const existingCredentials = opts.existingCredentials;
  const previousOwnerSub = opts.previousOwnerSub;
  if (!existingCredentials || !previousOwnerSub) {
    fail(
      "CLIENT_OWNER_UNKNOWN_REQUIRES_RESET_OR_OWNER_LOGIN",
      `A previous owner could not be identified, so First Tree cannot safely park the active local client. Run \`${channelConfig.binName} computer reset\` after backing up local state, or log in as the current owner.`,
      1,
    );
  }
  const oldClientId = readRootClientId(configDir);
  if (!oldClientId) {
    fail(
      "CLIENT_OWNER_UNKNOWN_REQUIRES_RESET_OR_OWNER_LOGIN",
      `Existing client.yaml does not contain a valid client id, so First Tree cannot safely park the active local client. Run \`${channelConfig.binName} computer reset\` after backing up local state, or log in as the current owner.`,
      1,
    );
  }

  acquireSwitchLock(home);
  const journal: SwitchJournal = {
    version: 1,
    id: `switch-${Date.now()}-${process.pid}`,
    phase: "locked",
    from: {
      clientId: oldClientId,
      userId: previousOwnerSub,
      serverUrl: existingCredentials.serverUrl,
    },
    to: {
      userId: opts.targetOwnerSub,
      serverUrl: opts.targetTokens.serverUrl,
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  try {
    writeJournal(home, journal);
    stopServiceForSwitch();
    updateJournal(home, journal, "service-stopped");

    assertNoLiveRuntimeMarkers(home, oldClientId);
    await assertSwitchDrainClean({ home, clientId: oldClientId });
    updateJournal(home, journal, "drain-clean");

    const index = readSwitchIndex(home);
    const targetClientId = index.accountDefaults[accountKey(opts.targetTokens.serverUrl, opts.targetOwnerSub)];
    if (targetClientId) journal.to.clientId = targetClientId;
    writeJournal(home, journal);

    const moves = buildSwitchMoves({ home, configDir, dataDir, fromClientId: oldClientId, toClientId: targetClientId });
    preflightSwitchRenames(moves);
    journal.moves = moves;
    writeJournal(home, journal);

    executeSwitchMoves(home, journal, "park");
    updateJournal(home, journal, "parked-old-client");

    executeSwitchMoves(home, journal, "restore");
    updateJournal(home, journal, "restored-target-client");

    rmSync(join(configDir, "credentials.json"), { force: true });
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    saveCredentials(opts.targetTokens);
    updateJournal(home, journal, "credentials-written");

    setConfigValue(join(configDir, "client.yaml"), "server.url", opts.targetTokens.serverUrl);
    resetConfig();
    resetConfigMeta();
    const config = await initConfig({ schema: clientConfigSchema, role: "client" });

    updateSwitchIndex(home, {
      from: {
        clientId: oldClientId,
        userId: previousOwnerSub,
        serverUrl: existingCredentials.serverUrl,
      },
      to: {
        clientId: config.client.id,
        userId: opts.targetOwnerSub,
        serverUrl: opts.targetTokens.serverUrl,
      },
    });
    journal.to.clientId = config.client.id;
    updateJournal(home, journal, "complete");
    clearSwitchLock(home);
    return config;
  } catch (err) {
    const journal = readJournal(home);
    if (!journalHasRootMovement(journal)) clearSwitchLock(home);
    if (err instanceof ClientSwitchCommandError) {
      fail(err.code, err.message, err.exitCode);
    }
    if (isExdevError(err)) {
      fail(
        "CLIENT_SWITCH_EXDEV",
        "Cannot switch local clients because active and parked client state are on different filesystems. First Tree will not copy local workspaces implicitly.",
        1,
      );
    }
    throw err;
  }
}

function formatSwitchConfirmationMessage(opts: {
  existingServerUrl: string;
  targetServerUrl: string;
  existingUserId?: string;
  targetUserId?: string;
  existingClientId?: string;
  targetClientId?: string;
}): string {
  const current = `${opts.existingUserId ?? "the current user"}${opts.existingClientId ? ` / ${opts.existingClientId}` : ""}`;
  const target = `${opts.targetUserId ?? "the target user"}${opts.targetClientId ? ` / restore ${opts.targetClientId}` : " / create or restore a separate local client"}`;
  return [
    `Switch this computer from ${current} to ${target}?`,
    "This will stop the current daemon and interrupt running agent work before local state is moved.",
    "Inactive First Tree refresh tokens are not kept; switching back requires a fresh `login <code>`.",
    "Provider auth is not isolated by First Tree and remains whatever this OS user is signed into.",
    "If runtime, provider, filesystem, or journal safety gates fail, the switch aborts without changing users.",
  ].join(" ");
}

async function completePendingSwitchForLogin(opts: {
  home: string;
  configDir: string;
  journal: SwitchJournal;
  opts: {
    targetTokens: StoredCredentials;
    targetOwnerSub: string;
  };
}): Promise<ClientConfig> {
  const { home, configDir, journal } = opts;
  try {
    if (journal.to.userId !== opts.opts.targetOwnerSub || journal.to.serverUrl !== opts.opts.targetTokens.serverUrl) {
      throwSwitchFailure(
        "CLIENT_SWITCH_MANUAL_REPAIR_REQUIRED",
        `A previous client switch is pending for user ${journal.to.userId} on ${journal.to.serverUrl}. Re-run login with that user's token, or inspect ${clientSwitchJournalPath(home)} before manual repair.`,
      );
    }
    if (!journal.moves || journal.moves.length === 0) {
      clearSwitchLock(home);
      throwSwitchFailure(
        "CLIENT_SWITCH_RETRY_REQUIRED",
        "A previous client switch stopped before root state movement. The switch guard was cleared; re-run login to start a fresh switch.",
      );
    }

    executeSwitchMoves(home, journal, "park");
    updateJournal(home, journal, "parked-old-client");
    executeSwitchMoves(home, journal, "restore");
    updateJournal(home, journal, "restored-target-client");

    rmSync(join(configDir, "credentials.json"), { force: true });
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    saveCredentials(opts.opts.targetTokens);
    updateJournal(home, journal, "credentials-written");

    setConfigValue(join(configDir, "client.yaml"), "server.url", opts.opts.targetTokens.serverUrl);
    resetConfig();
    resetConfigMeta();
    const config = await initConfig({ schema: clientConfigSchema, role: "client" });

    updateSwitchIndex(home, {
      from: journal.from,
      to: {
        clientId: config.client.id,
        userId: opts.opts.targetOwnerSub,
        serverUrl: opts.opts.targetTokens.serverUrl,
      },
    });
    journal.to.clientId = config.client.id;
    updateJournal(home, journal, "complete");
    clearSwitchLock(home);
    return config;
  } catch (err) {
    if (err instanceof ClientSwitchCommandError) {
      fail(err.code, err.message, err.exitCode);
    }
    if (isExdevError(err)) {
      fail(
        "CLIENT_SWITCH_EXDEV",
        "Cannot recover local client switch because active and parked client state are on different filesystems. First Tree will not copy local workspaces implicitly.",
        1,
      );
    }
    throw err;
  }
}

async function assertSwitchDrainClean(opts: { home: string; clientId: string }): Promise<void> {
  const first = collectMarkedProviderProcesses(opts.home, opts.clientId);
  if (!first.ok) throwSwitchFailure(first.code, first.reason);
  if (first.providers.length > 0) {
    throwSwitchFailure("CLIENT_SWITCH_DRAIN_TIMEOUT", formatLiveProviders(first.providers));
  }
  await sleep(500);
  const second = collectMarkedProviderProcesses(opts.home, opts.clientId);
  if (!second.ok) throwSwitchFailure(second.code, second.reason);
  if (second.providers.length > 0) {
    throwSwitchFailure("CLIENT_SWITCH_DRAIN_TIMEOUT", formatLiveProviders(second.providers));
  }
}

function collectMarkedProviderProcesses(home: string, clientId: string): DrainSnapshot {
  if (process.platform === "linux") return collectLinuxMarkedProviders(home, clientId);
  if (process.platform === "darwin") return collectDarwinMarkedProviders(home, clientId);
  return {
    ok: false,
    code: "CLIENT_SWITCH_DRAIN_UNSUPPORTED",
    reason: `Client switch drain is not supported on ${process.platform}; refusing to move root state.`,
  };
}

function collectDarwinMarkedProviders(home: string, clientId: string): DrainSnapshot {
  let output: string;
  try {
    output = execFileSync("ps", ["-Eww", "-axo", "pid=,command="], {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (err) {
    return {
      ok: false,
      code: "CLIENT_SWITCH_DRAIN_UNSUPPORTED",
      reason: `Unable to inspect process environment for switch drain: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const providers: MarkedProviderProcess[] = [];
  const issues: ProviderMarkerIssue[] = [];
  for (const line of output.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const command = match[2] ?? "";
    collectSwitchDrainProcessFromEnvText({ pid, command, envText: command, home, clientId, providers, issues });
    collectDaemonFromEnvText({ pid, command, envText: command, home, clientId, issues });
  }
  if (issues.length > 0) return untrustedProviderSnapshot(issues);
  return { ok: true, providers };
}

function collectLinuxMarkedProviders(home: string, clientId: string): DrainSnapshot {
  let procEntries: string[];
  try {
    procEntries = readdirSync("/proc");
  } catch (err) {
    return {
      ok: false,
      code: "CLIENT_SWITCH_DRAIN_UNSUPPORTED",
      reason: `Unable to inspect /proc for switch drain: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const providers: MarkedProviderProcess[] = [];
  const issues: ProviderMarkerIssue[] = [];
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  for (const entry of procEntries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    const procDir = join("/proc", entry);
    if (uid !== null && linuxUid(procDir) !== uid) continue;
    let command: string;
    try {
      command = readFileSync(join(procDir, "cmdline"), "utf8").replace(/\0/g, " ");
    } catch (err) {
      if (existsSync(procDir)) {
        return {
          ok: false,
          code: "CLIENT_SWITCH_DRAIN_UNSUPPORTED",
          reason: `Unable to read process ${pid} environment for switch drain: ${
            err instanceof Error ? err.message : String(err)
          }`,
        };
      }
      continue;
    }
    const envIsRequiredForDrain = isSwitchDrainEnvRequired(command);
    let envText: string;
    try {
      envText = readFileSync(join(procDir, "environ"), "utf8");
    } catch (err) {
      if (existsSync(procDir) && envIsRequiredForDrain) {
        return {
          ok: false,
          code: "CLIENT_SWITCH_DRAIN_UNSUPPORTED",
          reason: `Unable to read process ${pid} environment for switch drain: ${
            err instanceof Error ? err.message : String(err)
          }`,
        };
      }
      continue;
    }
    collectSwitchDrainProcessFromEnvText({ pid, command, envText, home, clientId, providers, issues });
    collectDaemonFromEnvText({ pid, command, envText, home, clientId, issues });
  }
  if (issues.length > 0) return untrustedProviderSnapshot(issues);
  return { ok: true, providers };
}

function linuxUid(procDir: string): number | null {
  try {
    const status = readFileSync(join(procDir, "status"), "utf8");
    const match = status.match(/^Uid:\s+(\d+)/m);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

export function collectSwitchDrainProcessFromEnvText(opts: {
  pid: number;
  command: string;
  envText: string;
  home: string;
  clientId: string;
  providers: MarkedProviderProcess[];
  issues: ProviderMarkerIssue[];
}): void {
  const markerHome = parseSwitchProcessEnvValue(opts.envText, "FIRST_TREE_HOME");
  if (markerHome !== opts.home) return;

  const knownProvider = isKnownProviderCommand(opts.command);
  const provider = parseSwitchProcessEnvValue(opts.envText, "FIRST_TREE_PROVIDER");
  const markerClientId = parseSwitchProcessEnvValue(opts.envText, "FIRST_TREE_CLIENT_ID");
  const drainVersion = parseSwitchProcessEnvValue(opts.envText, "FIRST_TREE_SWITCH_DRAIN_VERSION");
  if (!knownProvider && !provider && !markerClientId && !drainVersion && !isKnownDaemonRuntimeCommand(opts.command)) {
    return;
  }
  if (
    isKnownDaemonRuntimeCommand(opts.command) &&
    !knownProvider &&
    !provider &&
    drainVersion !== SWITCH_DRAIN_VERSION
  ) {
    return;
  }
  if (!markerClientId || drainVersion !== SWITCH_DRAIN_VERSION) {
    opts.issues.push({
      pid: opts.pid,
      command: opts.command,
      reason: "missing trusted switch drain markers",
    });
    return;
  }
  if (markerClientId !== opts.clientId) {
    opts.issues.push({
      pid: opts.pid,
      command: opts.command,
      reason: `belongs to another client (${markerClientId})`,
    });
    return;
  }
  opts.providers.push({
    pid: opts.pid,
    provider: provider ?? (knownProvider ? "unknown-provider" : "marked-descendant"),
    agentId: parseSwitchProcessEnvValue(opts.envText, "FIRST_TREE_AGENT_ID") ?? undefined,
    chatId: parseSwitchProcessEnvValue(opts.envText, "FIRST_TREE_CHAT_ID") ?? undefined,
    command: opts.command,
  });
}

function collectDaemonFromEnvText(opts: {
  pid: number;
  command: string;
  envText: string;
  home: string;
  clientId: string;
  issues: ProviderMarkerIssue[];
}): void {
  if (!isKnownDaemonRuntimeCommand(opts.command)) return;
  const markerHome = parseSwitchProcessEnvValue(opts.envText, "FIRST_TREE_HOME");
  const sameDefaultHomeWithoutEnv = !markerHome && opts.home === defaultHome();
  if (markerHome !== opts.home && !sameDefaultHomeWithoutEnv) return;

  const markerClientId = parseSwitchProcessEnvValue(opts.envText, "FIRST_TREE_CLIENT_ID");
  if (markerClientId && markerClientId !== opts.clientId) return;
  opts.issues.push({
    pid: opts.pid,
    command: opts.command,
    reason: markerClientId ? "daemon runtime is still active" : "daemon runtime lacks trusted switch drain markers",
  });
}

function untrustedProviderSnapshot(issues: ProviderMarkerIssue[]): DrainSnapshot {
  const lines = issues.slice(0, 8).map((issue) => `pid=${issue.pid} ${issue.reason}: ${issue.command}`);
  const suffix = issues.length > lines.length ? `\n  ...and ${issues.length - lines.length} more` : "";
  return {
    ok: false,
    code: "CLIENT_SWITCH_DRAIN_UNSUPPORTED",
    reason: `Found First Tree provider-like processes without trusted switch-drain markers; refusing to move root state.\n  ${lines.join("\n  ")}${suffix}`,
  };
}

export function parseSwitchProcessEnvValue(envText: string, key: string): string | null {
  const prefix = `${key}=`;
  if (envText.includes("\0")) {
    for (const entry of envText.split("\0")) {
      if (entry.startsWith(prefix)) return entry.slice(prefix.length);
    }
    return null;
  }
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = envText.match(new RegExp(`(?:^|\\s)${escaped}=`));
  if (!match || match.index === undefined) return null;
  const valueStart = match.index + match[0].length;
  const rest = envText.slice(valueStart);
  const nextEnv = rest.search(/\s[A-Za-z_][A-Za-z0-9_]*=/);
  if (nextEnv >= 0) return rest.slice(0, nextEnv);
  const token = rest.match(/^[^\s\0]+/);
  return token ? token[0] : "";
}

function isKnownProviderCommand(command: string): boolean {
  if (/(^|[/\s])(claude|codex|cursor-agent)(\s|$)/i.test(command) || /@openai\/codex|claude-code/i.test(command)) {
    return true;
  }
  // Cursor's official main command is the generic name `agent`. Match it ONLY
  // as the executed binary's basename (first argv token): a whole-command word
  // scan would drag every unrelated process that merely mentions "agent"
  // (ssh-agent arguments, `first-tree agent create`, …) into the fail-closed
  // env check and block switches on processes whose env cannot be read.
  const firstToken = command.trim().split(/\s+/, 1)[0] ?? "";
  const basename = firstToken.split("/").pop() ?? "";
  return basename.toLowerCase() === "agent";
}

function isKnownDaemonRuntimeCommand(command: string): boolean {
  if (!/\bdaemon\s+start\b/.test(command)) return false;
  return (
    /(^|[/\s])first-tree(?:-(?:dev|staging))?(\s|$)/.test(command) ||
    /(^|[/\s])(?:cli\/index|index)\.mjs(\s|$)/.test(command)
  );
}

export function isSwitchDrainEnvRequired(command: string): boolean {
  return isKnownProviderCommand(command) || isKnownDaemonRuntimeCommand(command);
}

function formatLiveProviders(providers: MarkedProviderProcess[]): string {
  const lines = providers
    .slice(0, 8)
    .map(
      (p) =>
        `pid=${p.pid} provider=${p.provider}${p.agentId ? ` agent=${p.agentId}` : ""}${p.chatId ? ` chat=${p.chatId}` : ""}`,
    );
  const suffix = providers.length > lines.length ? `\n  ...and ${providers.length - lines.length} more` : "";
  return `Provider processes are still running after account-switch interruption; refusing to move root state.\n  ${lines.join("\n  ")}${suffix}`;
}

function stopServiceForSwitch(): void {
  const before = getClientServiceStatus();
  if (before.state === "unknown") {
    throwSwitchFailure(
      "CLIENT_SWITCH_SUPERVISOR_UNSAFE",
      `Background service state could not be determined (${before.platform}${before.detail ? `: ${before.detail}` : ""}).`,
    );
  }
  if (before.state !== "active") return;
  const stopped = stopClientService();
  if (!stopped.ok) {
    throwSwitchFailure(
      "CLIENT_SWITCH_SUPERVISOR_UNSAFE",
      `Failed to stop background service before switch: ${stopped.reason}`,
    );
  }
  const after = getClientServiceStatus();
  if (after.state === "active" || after.state === "unknown") {
    throwSwitchFailure(
      "CLIENT_SWITCH_SUPERVISOR_UNSAFE",
      `Background service did not reach a safe stopped state (${after.platform}${after.detail ? `: ${after.detail}` : ""}).`,
    );
  }
}

function assertNoLiveRuntimeMarkers(home: string, clientId: string): void {
  const live = listLiveClientRuntimeMarkers(home, clientId);
  if (live.length > 0) {
    throwSwitchFailure("CLIENT_SWITCH_RUNTIME_ACTIVE", formatLiveRuntimes(live));
  }
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

function readPidCommand(pid: number): string | null {
  if (process.platform === "linux") {
    try {
      return (
        readFileSync(join("/proc", String(pid), "cmdline"), "utf8")
          .replace(/\0/g, " ")
          .trim() || null
      );
    } catch {
      return null;
    }
  }
  if (process.platform === "darwin") {
    try {
      return execFileSync("ps", ["-p", String(pid), "-o", "command="], {
        encoding: "utf8",
        timeout: 2000,
        maxBuffer: 1024 * 1024,
      }).trim();
    } catch {
      return null;
    }
  }
  return null;
}

function formatLiveRuntimes(runtimes: LiveRuntimeMarker[]): string {
  const lines = runtimes
    .slice(0, 8)
    .map((runtime) => `pid=${runtime.pid} mode=${runtime.mode}${runtime.command ? ` command=${runtime.command}` : ""}`);
  const suffix = runtimes.length > lines.length ? `\n  ...and ${runtimes.length - lines.length} more` : "";
  return `First Tree runtime processes are still running after account-switch interruption; refusing to move root state.\n  ${lines.join("\n  ")}${suffix}`;
}

function throwSwitchFailure(code: string, message: string): never {
  throw new ClientSwitchCommandError(code, message);
}

function buildSwitchMoves(opts: {
  home: string;
  configDir: string;
  dataDir: string;
  fromClientId: string;
  toClientId?: string;
}): SwitchJournalMove[] {
  const fromParkedRoot = parkedClientRoot(opts.home, opts.fromClientId);
  const moves: SwitchJournalMove[] = [
    move(
      "park-client-yaml",
      "park",
      join(opts.configDir, "client.yaml"),
      join(fromParkedRoot, "config", "client.yaml"),
      true,
    ),
    move("park-agents", "park", join(opts.configDir, "agents"), join(fromParkedRoot, "config", "agents"), false),
    move("park-sessions", "park", join(opts.dataDir, "sessions"), join(fromParkedRoot, "data", "sessions"), false),
    move(
      "park-workspaces",
      "park",
      join(opts.dataDir, "workspaces"),
      join(fromParkedRoot, "data", "workspaces"),
      false,
    ),
  ];

  if (!opts.toClientId) {
    moves.push({
      kind: "restore-client-yaml",
      group: "restore",
      source: join(opts.home, "parked-clients", "__new-client__", "config", "client.yaml"),
      target: join(opts.configDir, "client.yaml"),
      required: true,
      state: "create",
      updatedAt: new Date().toISOString(),
    });
    return moves;
  }

  const toParkedRoot = parkedClientRoot(opts.home, opts.toClientId);
  moves.push(
    move(
      "restore-client-yaml",
      "restore",
      join(toParkedRoot, "config", "client.yaml"),
      join(opts.configDir, "client.yaml"),
      true,
    ),
    move("restore-agents", "restore", join(toParkedRoot, "config", "agents"), join(opts.configDir, "agents"), false),
    move("restore-sessions", "restore", join(toParkedRoot, "data", "sessions"), join(opts.dataDir, "sessions"), false),
    move(
      "restore-workspaces",
      "restore",
      join(toParkedRoot, "data", "workspaces"),
      join(opts.dataDir, "workspaces"),
      false,
    ),
  );
  return moves;
}

function move(
  kind: SwitchMoveKind,
  group: SwitchMoveGroup,
  source: string,
  target: string,
  required: boolean,
): SwitchJournalMove {
  return { kind, group, source, target, required, state: "pending" };
}

function preflightSwitchRenames(moves: SwitchJournalMove[]): void {
  for (const entry of moves) {
    if (entry.state === "create" || !existsSync(entry.source)) continue;
    assertSameDeviceRename(entry.source, entry.target);
  }
}

function executeSwitchMoves(home: string, journal: SwitchJournal, group: SwitchMoveGroup): void {
  for (const entry of journal.moves ?? []) {
    if (entry.group !== group || entry.state !== "pending") continue;
    const sourceExists = existsSync(entry.source);
    const targetExists = existsSync(entry.target);
    if (!sourceExists && targetExists) {
      markMove(home, journal, entry, "done");
      continue;
    }
    if (!sourceExists && !targetExists) {
      if (!entry.required) {
        markMove(home, journal, entry, "absent");
        continue;
      }
      throwUnclassifiableMove(home, entry, "neither source nor target exists");
    }
    if (sourceExists && targetExists) {
      throwUnclassifiableMove(home, entry, "both source and target exist");
    }

    mkdirSync(dirname(entry.target), { recursive: true, mode: 0o700 });
    assertSameDeviceRename(entry.source, entry.target);
    renameSync(entry.source, entry.target);
    markMove(home, journal, entry, "done");
  }
}

function markMove(home: string, journal: SwitchJournal, entry: SwitchJournalMove, state: SwitchMoveState): void {
  entry.state = state;
  entry.updatedAt = new Date().toISOString();
  journal.updatedAt = entry.updatedAt;
  writeJournal(home, journal);
}

function throwUnclassifiableMove(home: string, entry: SwitchJournalMove, detail: string): never {
  throwSwitchFailure(
    "CLIENT_SWITCH_MANUAL_REPAIR_REQUIRED",
    `Client switch journal cannot safely recover ${entry.kind}: ${detail}. Inspect ${clientSwitchJournalPath(home)}, ${entry.source}, and ${entry.target} before manual repair.`,
  );
}

function journalHasRootMovement(journal: SwitchJournal | null): boolean {
  if (!journal) return false;
  if (journal.moves && journal.moves.length > 0) return true;
  return (
    journal.phase === "parked-old-client" ||
    journal.phase === "restored-target-client" ||
    journal.phase === "credentials-written" ||
    journal.phase === "complete"
  );
}

function assertSameDeviceRename(source: string, target: string): void {
  const sourceDev = statSync(source).dev;
  const targetParent = dirname(target);
  mkdirSync(targetParent, { recursive: true, mode: 0o700 });
  const targetDev = statSync(targetParent).dev;
  if (sourceDev !== targetDev) {
    const err = new Error(`EXDEV preflight: ${source} -> ${target}`);
    Object.assign(err, { code: "EXDEV" });
    throw err;
  }
}

function readRootClientId(configDir: string): string | null {
  const raw = readConfigFile(join(configDir, "client.yaml"));
  const client = raw.client;
  if (typeof client !== "object" || client === null) return null;
  const id = (client as { id?: unknown }).id;
  return typeof id === "string" && /^client_[a-f0-9]{8}$/.test(id) ? id : null;
}

function readSwitchIndex(home: string): SwitchIndex {
  try {
    const raw = JSON.parse(readFileSync(indexPath(home), "utf8")) as SwitchIndex;
    if (raw.version === 1 && raw.clients && raw.accountDefaults) return raw;
  } catch {
    // fall through
  }
  return { version: 1, accountDefaults: {}, clients: {} };
}

function updateSwitchIndex(
  home: string,
  opts: {
    from: { clientId: string; userId: string; serverUrl: string };
    to: { clientId: string; userId: string; serverUrl: string };
  },
): void {
  const now = new Date().toISOString();
  const index = readSwitchIndex(home);
  index.clients[opts.from.clientId] = {
    clientId: opts.from.clientId,
    userId: opts.from.userId,
    serverUrl: opts.from.serverUrl,
    storage: "parked",
    parkedPath: parkedClientRoot(home, opts.from.clientId),
    updatedAt: now,
  };
  index.clients[opts.to.clientId] = {
    clientId: opts.to.clientId,
    userId: opts.to.userId,
    serverUrl: opts.to.serverUrl,
    storage: "active-root",
    updatedAt: now,
  };
  index.accountDefaults[accountKey(opts.from.serverUrl, opts.from.userId)] = opts.from.clientId;
  index.accountDefaults[accountKey(opts.to.serverUrl, opts.to.userId)] = opts.to.clientId;
  index.activeClientId = opts.to.clientId;
  writeJsonAtomic(indexPath(home), index);
}

function accountKey(serverUrl: string, userId: string): string {
  return `${serverUrl}\n${userId}`;
}

function parkedClientRoot(home: string, clientId: string): string {
  return join(home, "parked-clients", clientId);
}

function indexPath(home: string): string {
  return join(home, "parked-clients", "index.json");
}

function acquireSwitchLock(home: string): void {
  const lockPath = clientSwitchLockPath(home);
  if (existsSync(lockPath) || existsSync(clientSwitchJournalPath(home))) {
    fail(
      "CLIENT_SWITCH_MANUAL_REPAIR_REQUIRED",
      "A previous client switch did not complete cleanly. Start-up is blocked until the switch journal is repaired or removed after inspection.",
      1,
    );
  }
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }, null, 2), {
    flag: "wx",
    mode: 0o600,
  });
}

function clearSwitchLock(home: string): void {
  rmSync(clientSwitchJournalPath(home), { force: true });
  rmSync(clientSwitchLockPath(home), { force: true });
}

function readJournal(home: string): SwitchJournal | null {
  try {
    return JSON.parse(readFileSync(clientSwitchJournalPath(home), "utf8")) as SwitchJournal;
  } catch {
    return null;
  }
}

function writeJournal(home: string, journal: SwitchJournal): void {
  writeJsonAtomic(clientSwitchJournalPath(home), journal);
}

function updateJournal(home: string, journal: SwitchJournal, phase: SwitchJournal["phase"]): void {
  journal.phase = phase;
  journal.updatedAt = new Date().toISOString();
  writeJournal(home, journal);
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp.${process.pid}`;
  try {
    writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // ignore cleanup failure
    }
    throw err;
  }
}

function isExdevError(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: unknown }).code === "EXDEV";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
