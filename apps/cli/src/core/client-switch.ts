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

export function getClientSwitchStartupBlock(home = defaultHome()): { lockPath: string; journalPath: string } | null {
  const lockPath = clientSwitchLockPath(home);
  const journalPath = clientSwitchJournalPath(home);
  if (existsSync(lockPath) || existsSync(journalPath)) return { lockPath, journalPath };
  return null;
}

export function resolveClientRuntimeStopReason(home = defaultHome()): string | undefined {
  return getClientSwitchStartupBlock(home) ? CLIENT_SWITCH_INTERRUPTED_REASON : undefined;
}

export async function confirmLocalClientSwitch(opts: {
  existingServerUrl: string;
  targetServerUrl: string;
  forceSwitch?: boolean;
}): Promise<void> {
  if (opts.forceSwitch === true) return;
  if (process.stdin.isTTY !== true) {
    fail(
      "ACCOUNT_SWITCH_REQUIRES_CONFIRMATION",
      "This connect token belongs to a different First Tree user. Re-run with `--force-switch` in non-interactive mode to confirm account switching. Safety checks still run and cannot be skipped.",
      1,
    );
  }
  const ok = await confirm({
    message:
      "Switch this computer to a different First Tree user? This will stop the current daemon and interrupt running agent work before local state is moved.",
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
  existingCredentials: StoredCredentials;
  previousOwnerSub: string;
  targetTokens: StoredCredentials;
  targetOwnerSub: string;
}): Promise<ClientConfig> {
  const home = defaultHome();
  const configDir = defaultConfigDir();
  const dataDir = defaultDataDir();
  const oldClientId = readRootClientId(configDir);
  if (!oldClientId) {
    fail(
      "CLIENT_OWNER_UNKNOWN_REQUIRES_RESET_OR_OWNER_LOGIN",
      `Existing client.yaml does not contain a valid client id, so First Tree cannot safely park the active local client. Run \`${channelConfig.binName} computer reset\` after backing up local state, or log in as the current owner.`,
      1,
    );
  }

  cleanupCompletedSwitch(home);
  acquireSwitchLock(home);
  const journal: SwitchJournal = {
    version: 1,
    id: `switch-${Date.now()}-${process.pid}`,
    phase: "locked",
    from: {
      clientId: oldClientId,
      userId: opts.previousOwnerSub,
      serverUrl: opts.existingCredentials.serverUrl,
    },
    to: {
      userId: opts.targetOwnerSub,
      serverUrl: opts.targetTokens.serverUrl,
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  let stateMoved = false;
  try {
    writeJournal(home, journal);
    stopServiceForSwitch();
    updateJournal(home, journal, "service-stopped");

    await assertSwitchDrainClean({ home, clientId: oldClientId });
    updateJournal(home, journal, "drain-clean");

    const index = readSwitchIndex(home);
    const targetClientId = index.accountDefaults[accountKey(opts.targetTokens.serverUrl, opts.targetOwnerSub)];
    if (targetClientId) journal.to.clientId = targetClientId;
    writeJournal(home, journal);

    preflightSwitchRenames({ home, configDir, dataDir, fromClientId: oldClientId, toClientId: targetClientId });
    stateMoved = true;
    parkActiveClient({ home, configDir, dataDir, clientId: oldClientId });
    updateJournal(home, journal, "parked-old-client");

    if (targetClientId) restoreParkedClient({ home, configDir, dataDir, clientId: targetClientId });
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
        userId: opts.previousOwnerSub,
        serverUrl: opts.existingCredentials.serverUrl,
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
    const journalMoved =
      journal?.phase === "parked-old-client" ||
      journal?.phase === "restored-target-client" ||
      journal?.phase === "credentials-written" ||
      journal?.phase === "complete";
    if (!stateMoved && !journalMoved) clearSwitchLock(home);
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
    collectProviderFromEnvText({ pid, command, envText: command, home, clientId, providers, issues });
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
    let envText: string;
    let command: string;
    try {
      envText = readFileSync(join(procDir, "environ"), "utf8");
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
    collectProviderFromEnvText({ pid, command, envText, home, clientId, providers, issues });
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

function collectProviderFromEnvText(opts: {
  pid: number;
  command: string;
  envText: string;
  home: string;
  clientId: string;
  providers: MarkedProviderProcess[];
  issues: ProviderMarkerIssue[];
}): void {
  if (!isKnownProviderCommand(opts.command)) return;
  const markerHome = envValue(opts.envText, "FIRST_TREE_HOME");
  if (markerHome !== opts.home) return;

  const provider = envValue(opts.envText, "FIRST_TREE_PROVIDER");
  const markerClientId = envValue(opts.envText, "FIRST_TREE_CLIENT_ID");
  const drainVersion = envValue(opts.envText, "FIRST_TREE_SWITCH_DRAIN_VERSION");
  if (!provider || !markerClientId || drainVersion !== SWITCH_DRAIN_VERSION) {
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
    provider,
    agentId: envValue(opts.envText, "FIRST_TREE_AGENT_ID") ?? undefined,
    chatId: envValue(opts.envText, "FIRST_TREE_CHAT_ID") ?? undefined,
    command: opts.command,
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

function envValue(envText: string, key: string): string | null {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = envText.match(new RegExp(`(?:^|[\\s\\0])${escaped}=([^\\s\\0]+)`));
  return match ? (match[1] ?? null) : null;
}

function isKnownProviderCommand(command: string): boolean {
  return /(^|[/\s])(claude|codex)(\s|$)/i.test(command) || /@openai\/codex|claude-code/i.test(command);
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

function throwSwitchFailure(code: string, message: string): never {
  throw new ClientSwitchCommandError(code, message);
}

function preflightSwitchRenames(opts: {
  home: string;
  configDir: string;
  dataDir: string;
  fromClientId: string;
  toClientId?: string;
}): void {
  const fromParkedRoot = parkedClientRoot(opts.home, opts.fromClientId);
  preflightRootEntry(join(opts.configDir, "client.yaml"), join(fromParkedRoot, "config", "client.yaml"));
  preflightRootEntry(join(opts.configDir, "agents"), join(fromParkedRoot, "config", "agents"));
  preflightRootEntry(join(opts.dataDir, "sessions"), join(fromParkedRoot, "data", "sessions"));
  preflightRootEntry(join(opts.dataDir, "workspaces"), join(fromParkedRoot, "data", "workspaces"));

  if (!opts.toClientId) return;
  const toParkedRoot = parkedClientRoot(opts.home, opts.toClientId);
  preflightRootEntry(join(toParkedRoot, "config", "client.yaml"), join(opts.configDir, "client.yaml"));
  preflightRootEntry(join(toParkedRoot, "config", "agents"), join(opts.configDir, "agents"));
  preflightRootEntry(join(toParkedRoot, "data", "sessions"), join(opts.dataDir, "sessions"));
  preflightRootEntry(join(toParkedRoot, "data", "workspaces"), join(opts.dataDir, "workspaces"));
}

function preflightRootEntry(source: string, target: string): void {
  if (!existsSync(source)) return;
  assertSameDeviceRename(source, target);
}

function parkActiveClient(opts: { home: string; configDir: string; dataDir: string; clientId: string }): void {
  const parkedRoot = parkedClientRoot(opts.home, opts.clientId);
  moveRootEntry(join(opts.configDir, "client.yaml"), join(parkedRoot, "config", "client.yaml"));
  moveRootEntry(join(opts.configDir, "agents"), join(parkedRoot, "config", "agents"));
  moveRootEntry(join(opts.dataDir, "sessions"), join(parkedRoot, "data", "sessions"));
  moveRootEntry(join(opts.dataDir, "workspaces"), join(parkedRoot, "data", "workspaces"));
}

function restoreParkedClient(opts: { home: string; configDir: string; dataDir: string; clientId: string }): void {
  const parkedRoot = parkedClientRoot(opts.home, opts.clientId);
  moveRootEntry(join(parkedRoot, "config", "client.yaml"), join(opts.configDir, "client.yaml"));
  moveRootEntry(join(parkedRoot, "config", "agents"), join(opts.configDir, "agents"));
  moveRootEntry(join(parkedRoot, "data", "sessions"), join(opts.dataDir, "sessions"));
  moveRootEntry(join(parkedRoot, "data", "workspaces"), join(opts.dataDir, "workspaces"));
}

function moveRootEntry(source: string, target: string): void {
  if (!existsSync(source)) return;
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  assertSameDeviceRename(source, target);
  rmSync(target, { recursive: true, force: true });
  try {
    renameSync(source, target);
  } catch (err) {
    if (isExdevError(err)) throw err;
    throw err;
  }
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

function cleanupCompletedSwitch(home: string): void {
  const journal = readJournal(home);
  if (journal?.phase === "complete") clearSwitchLock(home);
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
