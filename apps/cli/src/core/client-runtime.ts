import type { FSWatcher } from "node:fs";
import { existsSync, mkdirSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AgentSlot,
  ClientConnection,
  createGitMirrorManager,
  createLogger,
  type GitMirrorManager,
  getHandlerFactory,
  registerBuiltinHandlers,
  type UpdateHooks,
  UpdateManager,
} from "@first-tree/client";
import type { AgentPinnedMessage } from "@first-tree/shared";
import type { AgentConfig } from "@first-tree/shared/config";
import { agentConfigSchema, DEFAULT_DATA_DIR, loadAgents } from "@first-tree/shared/config";
import { stringify as stringifyYaml } from "yaml";
import { ensureFreshAccessToken } from "./bootstrap.js";
import { print } from "./output.js";
import { readUpdateState } from "./update-state.js";
import { CLI_USER_AGENT } from "./version.js";

type AgentEntry = {
  name: string;
  slot: AgentSlot;
};

export type ClientRuntimeOptions = {
  /**
   * Version of the Command package this process was launched from. Passed to
   * the server as `sdkVersion` on `client:register` and compared against the
   * version the server advertises in `server:welcome`. Required to engage
   * self-update.
   */
  currentVersion?: string;
  /**
   * Self-update config + command-layer callbacks. All-or-nothing: the
   * UpdateManager attaches only when this and `currentVersion` are both set.
   */
  update?: UpdateHooks;
};

/**
 * Client runtime — one shared ClientConnection, multiple agents multiplexed.
 *
 * Unified-user-token milestone:
 *   - Auth comes from the user's JWT in `credentials.json`; there is no
 *     per-agent token. `ensureFreshAccessToken` is called on every handshake
 *     + every SDK request, so long-lived connections refresh transparently.
 *   - Agent identity on the WS comes from `agents/<name>/agent.yaml::agentId`.
 *     The server's Rule R-RUN refuses binds for agents not pinned to this
 *     client — the operator has to run `agent create --client-id <thisId>`
 *     first.
 */
export class ClientRuntime {
  private readonly serverUrl: string;
  private readonly connection: ClientConnection;
  /**
   * One GitMirrorManager per runtime — every slot gets the same instance.
   * The manager's per-URL serial queue is what stops two agents on the same
   * chat from racing on `git worktree add` against the shared bare mirror's
   * `config`; one manager per slot would defeat the lock.
   */
  private readonly gitMirrorManager: GitMirrorManager;
  private readonly agents: AgentEntry[] = [];
  private readonly agentNames = new Set<string>();
  private readonly agentIds = new Set<string>();
  private readonly options: ClientRuntimeOptions;
  private updateManager: UpdateManager | null = null;
  private watcher: FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Directory we write auto-registered agent configs into (same path that
   * `first-tree agent add` uses). Set by `watchAgentsDir` so the
   * `agent:pinned` handler knows where to materialise new configs.
   */
  private agentsDir: string | null = null;

  constructor(serverUrl: string, clientId: string, options: ClientRuntimeOptions = {}) {
    this.serverUrl = serverUrl;
    this.options = options;
    this.connection = new ClientConnection({
      serverUrl,
      clientId,
      sdkVersion: options.currentVersion,
      userAgent: CLI_USER_AGENT,
      getAccessToken: (opts) => ensureFreshAccessToken(opts),
      // Forward the last self-update outcome on every `client:register`
      // so the server can persist it into `clients.metadata.lastUpdateAttempt`
      // and the admin dashboard can flag clients that are failing to
      // self-update. Read is synchronous (small JSON file) and tolerant —
      // missing / corrupt state file simply omits the field.
      getLastUpdateAttempt: () => readUpdateState()?.last ?? null,
    });
    this.gitMirrorManager = createGitMirrorManager({
      dataDir: DEFAULT_DATA_DIR,
      log: createLogger("git-mirror"),
      // Authorise auto-recovery of orphaned worktree leftovers (kill holders +
      // rm -rf) for any target under the per-agent workspaces tree. Operator
      // paths outside this root still fail loud — see GitMirrorManagerOptions.
      hubManagedRoots: [join(DEFAULT_DATA_DIR, "workspaces")],
    });
    registerBuiltinHandlers();

    this.connection.on("auth:expired", () => {
      print.status("⚠️", "access token expired — reconnecting after refresh...");
    });

    // Refresh token rejected by the server — the local credentials cannot
    // refresh themselves out of this state, so retrying is pointless and the
    // 1Hz reconnect storm just burns CPU + log volume. Print recovery
    // instructions and exit 75 (TEMPFAIL) so systemd/launchd applies its
    // restart backoff instead of letting us thrash. The operator gets a
    // fresh token from the Web Computers page → New Connection and re-runs
    // `first-tree login <token>`.
    this.connection.on("auth:fatal", (err) => {
      print.blank();
      print.status("✗", "auth expired — service is shutting down to break the reconnect loop.");
      print.status("", err.message);
      print.status("", "Recovery: get a new connect token from your Hub's Web admin");
      print.status("", "          (Computers → + New Connection), then re-run the command shown.");
      // Honour the unit test environment which will assert via process.exit
      // mocks; in production this triggers the supervisor's restart backoff.
      process.exit(75);
    });

    // Surface transport-level errors (TLS resets, DNS hiccups, WS handshake
    // failures) to the operator. ClientConnection's own reconnect loop handles
    // recovery; the process-wide crash guard lives in ClientConnection itself.
    this.connection.on("error", (err) => {
      print.status("⚠️", `client connection error: ${err.message}`);
    });

    // Server tells us an agent has just been pinned to this client — mirror
    // what `first-tree agent add` does (write local config) and let the
    // scanForNewAgents helper start the slot. The fs watcher, when active,
    // is also a fallback path for the same flow.
    this.connection.on("agent:pinned", (message) => {
      this.handleAgentPinned(message);
    });
  }

  addAgent(name: string, config: AgentConfig): void {
    if (this.agentNames.has(name)) return;
    const handlerFactory = getHandlerFactory(config.runtime);
    const slot = new AgentSlot({
      name,
      agentId: config.agentId,
      serverUrl: this.serverUrl,
      type: config.runtime,
      handlerFactory,
      session: {
        idle_timeout: config.session.idle_timeout,
        max_sessions: config.session.max_sessions,
        working_grace_seconds: config.session.working_grace_seconds,
        // Admin-managed runtime config doesn't carry this field yet; local
        // `agent.yaml` users can override via the client YAML schema.
        reconcile_interval_seconds: 300,
      },
      concurrency: config.concurrency,
      clientConnection: this.connection,
      gitMirrorManager: this.gitMirrorManager,
    });
    this.agents.push({ name, slot });
    this.agentNames.add(name);
    this.agentIds.add(config.agentId);
  }

  async start(): Promise<void> {
    // Sweep orphan `hub-session-*` branches left over from previous runs
    // before any slot can race a `git worktree add`. Sessions suspend on idle
    // rather than terminate, so the cleanup path that normally runs
    // `branch -D` (handler.shutdown → cleanupGitWorktrees → removeWorktree)
    // fires only on explicit terminate/eviction. Without this sweep, every
    // crash or `branch -D` failure leaks a `[branch "..."]` segment in the
    // shared bare mirror's `config` forever.
    try {
      const sweep = await this.gitMirrorManager.gcOrphanSessionBranches();
      if (sweep.scanned > 0) {
        print.status(
          "[git-mirror]",
          `swept orphan session branches — scanned=${sweep.scanned} deleted=${sweep.deleted} failed=${sweep.failed}`,
        );
      }
    } catch (err) {
      print.status("⚠️", `git-mirror orphan sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Attach before connecting so the first welcome frame on a stale client
    // is acted on rather than missed until the next reconnect.
    if (this.options.currentVersion && this.options.update) {
      this.updateManager = UpdateManager.attach(this.connection, {
        currentVersion: this.options.currentVersion,
        ...this.options.update,
        isTTY: Boolean(process.stdout.isTTY),
        log: (level, msg) => print.status(`[update/${level}]`, msg),
        getQuietGateSnapshot: () => this.aggregateQuietGate(),
      });
    }

    await this.connection.connect();
    print.check(true, "client registered", this.connection.clientId);

    if (this.agents.length === 0) {
      print.blank();
      print.status("", "no agents configured yet.");
      print.status("", "add one with: first-tree agent create <name> --type claude-code --client-id <id>");
      print.blank();
      return;
    }

    await Promise.allSettled(
      this.agents.map(async (agent) => {
        try {
          const identity = await agent.slot.start();
          print.check(true, `${agent.name}: connected`, `agent: ${identity.displayName ?? identity.agentId}`);
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          print.check(false, `${agent.name}: connection failed`, msg);
        }
      }),
    );

    const connected = this.agents.length;
    print.blank();
    print.status("", `${connected} agent(s) running. Press Ctrl+C to stop.`);
  }

  watchAgentsDir(agentsDir: string): void {
    // Record the directory even if the watcher bails (e.g. dir missing) so
    // the `agent:pinned` handler knows where to materialise configs.
    this.agentsDir = agentsDir;
    if (this.watcher) return;
    if (!existsSync(agentsDir)) return;

    this.watcher = watch(agentsDir, { recursive: true }, () => {
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => {
        this.debounceTimer = null;
        this.scanForNewAgents(agentsDir);
      }, 500);
    });
  }

  unwatchAgentsDir(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }

  async stop(): Promise<void> {
    this.unwatchAgentsDir();
    this.updateManager?.dispose();
    this.updateManager = null;
    await Promise.allSettled(this.agents.map((a) => a.slot.stop()));
    await this.connection.disconnect();
  }

  private aggregateQuietGate(): { activeCount: number; lastActivityMs: number } {
    let activeCount = 0;
    let lastActivityMs = 0;
    for (const entry of this.agents) {
      const snap = entry.slot.getQuietGateSnapshot();
      activeCount += snap.activeCount;
      if (snap.lastActivityMs > lastActivityMs) lastActivityMs = snap.lastActivityMs;
    }
    return { activeCount, lastActivityMs };
  }

  private scanForNewAgents(agentsDir: string): void {
    try {
      const all = loadAgents({ schema: agentConfigSchema, agentsDir });
      for (const [name, config] of all) {
        if (this.agentNames.has(name)) continue;
        if (this.agentIds.has(config.agentId)) continue;

        print.blank();
        print.status("", `new agent detected: ${name}`);
        this.addAgent(name, config);
        this.startAgent(name);
      }
    } catch {
      // Ignore transient read errors during file writes
    }
  }

  /**
   * React to an `agent:pinned` server push by writing the local config file
   * (same shape `first-tree agent add` produces) and scheduling the new
   * slot — so the operator doesn't have to run `agent add` manually after
   * creating an agent from the admin UI or API.
   */
  private handleAgentPinned(message: AgentPinnedMessage): void {
    // Skip if we already track this agentId — avoids double-registration when
    // the user also ran `agent add` manually, or when the server re-fires on
    // reconnect in the future.
    if (this.agentIds.has(message.agentId)) return;

    if (!this.agentsDir) {
      print.status("⚠️", `agent pinned (${message.agentId}) but no agents dir set — cannot auto-register.`);
      return;
    }

    const localName = this.pickLocalName(message);
    const agentDir = join(this.agentsDir, localName);
    try {
      mkdirSync(agentDir, { recursive: true, mode: 0o700 });
      const yaml = stringifyYaml({ agentId: message.agentId, runtime: message.runtimeProvider });
      writeFileSync(join(agentDir, "agent.yaml"), yaml, { mode: 0o600 });
      print.check(true, `auto-added agent "${localName}"`, `${message.agentId} (from server push)`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      print.check(false, `failed to auto-add agent "${localName}"`, msg);
      return;
    }

    // The fs watcher would eventually pick this up with a 500 ms debounce,
    // but call the scan directly so the new slot starts promptly — especially
    // important when the watcher is not active (e.g. tests, Docker builds).
    this.scanForNewAgents(this.agentsDir);
  }

  /**
   * Choose the directory name under `agents/<name>/agent.yaml` for an agent
   * pushed by the server. Prefer the server-side `name` when set and not
   * already claimed; otherwise fall back to a UUID-derived name with a numeric
   * suffix on collision.
   *
   * UUID v7 packs the unix-ms timestamp in the high bits, so two agents
   * created in the same millisecond share the first 8 hex chars. Take 16 chars
   * (the full ms-timestamp segment plus the random tail) to make accidental
   * collisions astronomically unlikely, and re-check `agentNames` so even an
   * adversarial collision falls through to a `-2`, `-3`, … suffix.
   */
  private pickLocalName(message: AgentPinnedMessage): string {
    const preferred = message.name;
    if (preferred && !this.agentNames.has(preferred)) return preferred;
    const shortId = message.agentId
      .replace(/[^a-z0-9]/gi, "")
      .slice(0, 16)
      .toLowerCase();
    const base = `agent-${shortId}`;
    if (!this.agentNames.has(base)) return base;
    for (let suffix = 2; suffix < 1000; suffix++) {
      const candidate = `${base}-${suffix}`;
      if (!this.agentNames.has(candidate)) return candidate;
    }
    // Pathological fallback — UUID-derived names colliding 1000 times means
    // something is structurally wrong upstream. Use the full agentId so we at
    // least don't return a duplicate name and overwrite an existing config.
    return `agent-${message.agentId.replace(/[^a-z0-9]/gi, "").toLowerCase()}`;
  }

  private startAgent(name: string): void {
    const entry = this.agents.find((a) => a.name === name);
    if (!entry) return;
    entry.slot
      .start()
      .then((identity) => {
        print.check(true, `${name}: connected`, `agent: ${identity.displayName ?? identity.agentId}`);
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        print.check(false, `${name}: connection failed`, msg);
      });
  }
}
