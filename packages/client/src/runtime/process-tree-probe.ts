import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import type { pino } from "../observability/logger.js";

const execFileAsync = promisify(execFile);

/**
 * Detects whether a session's provider process currently has any live
 * descendant process — e.g. a `Bash run_in_background` watcher polling a CI
 * run. SessionManager consults this to defer idle-suspend and to deprioritize
 * concurrency eviction while such background work is in flight, so the
 * provider's "background task complete -> re-invoke the agent" wake-up is not
 * lost by tearing the session down underneath it.
 *
 * The provider (a `claude` process spawned by the Claude Agent SDK) is a direct
 * child of this daemon process, and the daemon stamps a per-session
 * `FIRST_TREE_CHAT_ID` env var onto it. So the probe maps a provider pid back
 * to its chatId by reading that env var; it never needs to track individual
 * child pids — only whether the provider currently has a descendant at all.
 */
export interface SubprocessProbe {
  /** True if the provider for `chatId` currently has at least one live descendant. */
  hasLiveSubprocess(chatId: string): boolean;
  /** Stop the background refresh loop (called on SessionManager shutdown). */
  stop(): void;
}

export type ProcessRow = { pid: number; ppid: number; comm: string };
export type ProviderProcessName = "claude" | "codex";
export const PROVIDER_DRAIN_PROCESS_NAMES: readonly ProviderProcessName[] = ["claude", "codex"];

export type ProviderDrainProcess = {
  pid: number;
  ppid: number;
  comm: string;
  provider: ProviderProcessName;
  clientId: string | null;
  agentId: string | null;
  chatId: string | null;
  home: string | null;
  descendantPids: number[];
};

export type ProviderDrainSnapshot = { ok: true; processes: ProviderDrainProcess[] } | { ok: false; reason: string };

/** Parse `ps -axo pid=,ppid=,comm=` output into rows. Unparseable lines are skipped. */
export function parseProcessRows(output: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) continue;
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), comm: match[3] ?? "" });
  }
  return rows;
}

/** Build a parent-pid -> child-pids adjacency index. */
export function buildChildrenIndex(rows: readonly ProcessRow[]): Map<number, number[]> {
  const byParent = new Map<number, number[]>();
  for (const { pid, ppid } of rows) {
    const existing = byParent.get(ppid);
    if (existing) existing.push(pid);
    else byParent.set(ppid, [pid]);
  }
  return byParent;
}

/** A provider is a `claude` process; `comm` is a full path on macOS, a basename on Linux. */
function isClaudeComm(comm: string): boolean {
  return comm === "claude" || comm.endsWith("/claude");
}

function basenameForComm(comm: string): string {
  return comm.split(/[\\/]/).pop() ?? comm;
}

export function providerNameForComm(comm: string): ProviderProcessName | null {
  const base = basenameForComm(comm);
  for (const name of PROVIDER_DRAIN_PROCESS_NAMES) {
    if (base === name) return name;
  }
  return null;
}

/** Provider pids = `claude` processes that are direct children of the daemon. */
export function findProviderPids(rows: readonly ProcessRow[], daemonPid: number): number[] {
  return rows.filter((row) => row.ppid === daemonPid && isClaudeComm(row.comm)).map((row) => row.pid);
}

/**
 * True if `pid` has at least one direct child. A direct-child check is
 * sufficient to detect any live descendant: a `run_in_background` task lives
 * under the launcher shell (a direct child of the provider) for its whole life,
 * and if that launcher exits the task reparents to the provider (a subreaper) —
 * so a live descendant always implies a live direct child.
 */
export function hasDescendant(pid: number, childrenByParent: ReadonlyMap<number, number[]>): boolean {
  return (childrenByParent.get(pid)?.length ?? 0) > 0;
}

export function collectDescendantPids(pid: number, childrenByParent: ReadonlyMap<number, number[]>): number[] {
  const out: number[] = [];
  const stack = [...(childrenByParent.get(pid) ?? [])];
  while (stack.length > 0) {
    const child = stack.pop();
    if (child === undefined) continue;
    out.push(child);
    stack.push(...(childrenByParent.get(child) ?? []));
  }
  out.sort((a, b) => a - b);
  return out;
}

export function buildParentIndex(rows: readonly ProcessRow[]): Map<number, number> {
  const byPid = new Map<number, number>();
  for (const { pid, ppid } of rows) byPid.set(pid, ppid);
  return byPid;
}

export function isDescendantOf(pid: number, ancestorPid: number, parentByPid: ReadonlyMap<number, number>): boolean {
  let current = parentByPid.get(pid);
  const seen = new Set<number>();
  while (typeof current === "number" && current > 0 && !seen.has(current)) {
    if (current === ancestorPid) return true;
    seen.add(current);
    current = parentByPid.get(current);
  }
  return false;
}

/**
 * Extract the `FIRST_TREE_CHAT_ID` value from a process's environment dump.
 * Handles both forms produced by {@link defaultEnvForPid}: space-separated
 * (Darwin `ps -Eww`) and NUL-separated (Linux `/proc/<pid>/environ`). The value
 * therefore stops at the next whitespace OR NUL, so it never bleeds into the
 * following env entry.
 */
export function extractChatId(envText: string): string | null {
  const match = envText.match(/\bFIRST_TREE_CHAT_ID=([^\s\0]+)/);
  return match ? (match[1] ?? null) : null;
}

export function extractEnvValue(envText: string, key: string): string | null {
  if (envText.includes("\0")) {
    const prefix = `${key}=`;
    for (const part of envText.split("\0")) {
      if (part.startsWith(prefix)) return part.slice(prefix.length);
    }
    return null;
  }
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = envText.match(new RegExp(`(?:^|[\\s\\0])${escaped}=([^\\s\\0]+)`));
  return match ? (match[1] ?? null) : null;
}

type PsSubprocessProbeOptions = {
  log: pino.Logger;
  /** Defaults to this daemon process. */
  daemonPid?: number;
  /** Refresh cadence; defaults to 10s (matches the idle-eviction tick). */
  intervalMs?: number;
  /** Injectable for tests: returns `ps -axo pid=,ppid=,comm=` stdout. */
  runProcessSnapshot?: () => Promise<string>;
  /** Injectable for tests: returns `ps -Eww -p <pid> -o command=` stdout. */
  runEnvForPid?: (pid: number) => Promise<string>;
};

export type OsProviderDrainSourceOptions = {
  /** Defaults to this process. Used when checking a live daemon's process tree. */
  daemonPid?: number;
  /** Active local client id. Preferred switch-drain scope once provider env carries it. */
  clientId?: string;
  /** Current FIRST_TREE_HOME. Covers older provider envs before FIRST_TREE_CLIENT_ID existed. */
  home?: string;
  /** Optional narrower scope for callers that already know local agent ids. */
  agentIds?: readonly string[];
  /** Injectable for tests: returns `ps -axo pid=,ppid=,comm=` stdout. */
  runProcessSnapshot?: () => Promise<string>;
  /** Injectable for tests: returns the provider process env text. */
  runEnvForPid?: (pid: number) => Promise<string>;
};

async function defaultProcessSnapshot(): Promise<string> {
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,comm="]);
  return stdout;
}

async function defaultEnvForPid(pid: number): Promise<string> {
  // Platform-aware: Linux/procps rejects the BSD `-E` flag, so read the env
  // directly from procfs there (NUL-separated KEY=VALUE entries). Darwin/BSD
  // `ps` has no procfs, so use its `-E` form. Either output is understood by
  // `extractChatId`.
  if (process.platform === "linux") {
    return readFile(`/proc/${pid}/environ`, "utf8");
  }
  const { stdout } = await execFileAsync("ps", ["-Eww", "-p", String(pid), "-o", "command="]);
  return stdout;
}

function hasDrainScope(opts: OsProviderDrainSourceOptions): boolean {
  return Boolean(opts.clientId || opts.home || (opts.agentIds && opts.agentIds.length > 0) || opts.daemonPid);
}

function processMatchesDrainScope(input: {
  envText: string;
  pid: number;
  opts: OsProviderDrainSourceOptions;
  parentByPid: ReadonlyMap<number, number>;
}): boolean {
  const { envText, pid, opts, parentByPid } = input;
  if (opts.clientId && extractEnvValue(envText, "FIRST_TREE_CLIENT_ID") === opts.clientId) return true;
  if (opts.home && extractEnvValue(envText, "FIRST_TREE_HOME") === opts.home) return true;
  const agentId = extractEnvValue(envText, "FIRST_TREE_AGENT_ID");
  if (agentId && opts.agentIds?.includes(agentId)) return true;
  if (typeof opts.daemonPid === "number" && isDescendantOf(pid, opts.daemonPid, parentByPid)) return true;
  return false;
}

/**
 * Fail-closed process-tree source for client-switch drain. Unlike
 * {@link PsSubprocessProbe}, which is an idle-suspend hint and degrades to
 * "no live background work", this source is a safety gate: a process or env
 * snapshot failure means the caller cannot prove the old provider is gone.
 */
export class OsProviderDrainSource {
  private readonly daemonPid: number | undefined;
  private readonly runProcessSnapshot: () => Promise<string>;
  private readonly runEnvForPid: (pid: number) => Promise<string>;

  constructor(private readonly opts: OsProviderDrainSourceOptions = {}) {
    this.daemonPid = opts.daemonPid;
    this.runProcessSnapshot = opts.runProcessSnapshot ?? defaultProcessSnapshot;
    this.runEnvForPid = opts.runEnvForPid ?? defaultEnvForPid;
  }

  async snapshot(): Promise<ProviderDrainSnapshot> {
    if (!hasDrainScope({ ...this.opts, daemonPid: this.daemonPid })) {
      return { ok: false, reason: "provider drain source has no client/home/agent/daemon scope" };
    }

    let rows: ProcessRow[];
    try {
      rows = parseProcessRows(await this.runProcessSnapshot());
    } catch (err) {
      return {
        ok: false,
        reason: `provider process snapshot failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const parentByPid = buildParentIndex(rows);
    const childrenByParent = buildChildrenIndex(rows);
    const processes: ProviderDrainProcess[] = [];
    for (const row of rows) {
      const provider = providerNameForComm(row.comm);
      if (!provider) continue;
      let envText: string;
      try {
        envText = await this.runEnvForPid(row.pid);
      } catch (err) {
        return {
          ok: false,
          reason: `provider process env read failed for pid ${row.pid}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        };
      }
      const scoped = processMatchesDrainScope({
        envText,
        pid: row.pid,
        opts: { ...this.opts, daemonPid: this.daemonPid },
        parentByPid,
      });
      if (!scoped) continue;
      processes.push({
        pid: row.pid,
        ppid: row.ppid,
        comm: row.comm,
        provider,
        clientId: extractEnvValue(envText, "FIRST_TREE_CLIENT_ID"),
        agentId: extractEnvValue(envText, "FIRST_TREE_AGENT_ID"),
        chatId: extractChatId(envText),
        home: extractEnvValue(envText, "FIRST_TREE_HOME"),
        descendantPids: collectDescendantPids(row.pid, childrenByParent),
      });
    }

    processes.sort((a, b) => a.pid - b.pid);
    return { ok: true, processes };
  }
}

export class ProviderDrainBlockedError extends Error {
  constructor(
    message: string,
    readonly snapshot: ProviderDrainSnapshot,
  ) {
    super(message);
    this.name = "ProviderDrainBlockedError";
  }
}

export async function assertProviderDrainClear(source: Pick<OsProviderDrainSource, "snapshot">): Promise<void> {
  const snapshot = await source.snapshot();
  if (!snapshot.ok) {
    throw new ProviderDrainBlockedError(`provider drain source unavailable: ${snapshot.reason}`, snapshot);
  }
  if (snapshot.processes.length > 0) {
    const details = snapshot.processes
      .map((p) => `${p.provider} pid ${p.pid}${p.chatId ? ` chat ${p.chatId}` : ""}`)
      .join(", ");
    throw new ProviderDrainBlockedError(`provider processes still live: ${details}`, snapshot);
  }
}

/**
 * `ps`-backed {@link SubprocessProbe}. Refreshes a `chatId -> has-live-subprocess`
 * snapshot on a background interval (async, off the event-loop hot path) so the
 * synchronous `hasLiveSubprocess` lookup used inside `evictIdle` never blocks on
 * a process scan.
 */
export class PsSubprocessProbe implements SubprocessProbe {
  private chatIdsWithLiveWork = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private inflight: Promise<void> | null = null;
  private readonly daemonPid: number;
  private readonly runProcessSnapshot: () => Promise<string>;
  private readonly runEnvForPid: (pid: number) => Promise<string>;

  constructor(private readonly opts: PsSubprocessProbeOptions) {
    this.daemonPid = opts.daemonPid ?? process.pid;
    this.runProcessSnapshot = opts.runProcessSnapshot ?? defaultProcessSnapshot;
    this.runEnvForPid = opts.runEnvForPid ?? defaultEnvForPid;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), opts.intervalMs ?? 10_000);
    // Never keep the process alive just for the probe.
    this.timer.unref?.();
  }

  hasLiveSubprocess(chatId: string): boolean {
    return this.chatIdsWithLiveWork.has(chatId);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Recompute the snapshot once. Concurrent callers share the in-flight run
   * (so a test can `await refresh()` and deterministically observe the result
   * of the constructor's initial refresh).
   */
  refresh(): Promise<void> {
    if (this.inflight) return this.inflight;
    this.inflight = this.doRefresh().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async doRefresh(): Promise<void> {
    try {
      const rows = parseProcessRows(await this.runProcessSnapshot());
      const childrenByParent = buildChildrenIndex(rows);
      const next = new Set<string>();
      for (const providerPid of findProviderPids(rows, this.daemonPid)) {
        if (!hasDescendant(providerPid, childrenByParent)) continue;
        const chatId = extractChatId(await this.runEnvForPid(providerPid));
        if (chatId) next.add(chatId);
      }
      this.chatIdsWithLiveWork = next;
    } catch (err) {
      // A probe failure must never wedge the runtime: fall back to "no live
      // work", which simply lets suspend proceed exactly as it did before this
      // feature existed.
      this.opts.log.debug(
        { err },
        "subprocess probe refresh failed; treating all sessions as having no live subprocess",
      );
      this.chatIdsWithLiveWork = new Set();
    }
  }
}
