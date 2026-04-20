import type { FSWatcher } from "node:fs";
import { existsSync, mkdirSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentPinnedMessage } from "@agent-team-foundation/first-tree-hub-shared";
import type { AgentConfig } from "@agent-team-foundation/first-tree-hub-shared/config";
import { agentConfigSchema, loadAgents } from "@agent-team-foundation/first-tree-hub-shared/config";
import { AgentSlot, ClientConnection, getHandlerFactory, registerBuiltinHandlers } from "@first-tree-hub/client";
import { ensureFreshAccessToken } from "./bootstrap.js";

type AgentEntry = {
  name: string;
  slot: AgentSlot;
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
  private readonly agents: AgentEntry[] = [];
  private readonly agentNames = new Set<string>();
  private readonly agentIds = new Set<string>();
  private watcher: FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Directory we write auto-registered agent configs into (same path that
   * `first-tree-hub agent add` uses). Set by `watchAgentsDir` so the
   * `agent:pinned` handler knows where to materialise new configs.
   */
  private agentsDir: string | null = null;

  constructor(serverUrl: string, clientId: string) {
    this.serverUrl = serverUrl;
    this.connection = new ClientConnection({
      serverUrl,
      clientId,
      getAccessToken: () => ensureFreshAccessToken(),
    });
    registerBuiltinHandlers();

    this.connection.on("auth:expired", () => {
      process.stderr.write("  \u26A0\uFE0F  Access token expired — reconnecting after refresh...\n");
    });

    // Server tells us an agent has just been pinned to this client — mirror
    // what `first-tree-hub agent add` does (write local config) and let the
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
      },
      concurrency: config.concurrency,
      clientConnection: this.connection,
    });
    this.agents.push({ name, slot });
    this.agentNames.add(name);
    this.agentIds.add(config.agentId);
  }

  async start(): Promise<void> {
    await this.connection.connect();
    process.stderr.write(`  \u2713 Client registered: ${this.connection.clientId}\n`);

    if (this.agents.length === 0) {
      process.stderr.write("\n  No agents configured yet.\n");
      process.stderr.write(
        "  Add one with: first-tree-hub agent create <name> --type claude-code --client-id <id>\n\n",
      );
      return;
    }

    await Promise.allSettled(
      this.agents.map(async (agent) => {
        try {
          const identity = await agent.slot.start();
          process.stderr.write(
            `  \u2713 ${agent.name}: connected (agent: ${identity.displayName ?? identity.agentId})\n`,
          );
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          process.stderr.write(`  \u2717 ${agent.name}: connection failed \u2014 ${msg}\n`);
        }
      }),
    );

    const connected = this.agents.length;
    process.stderr.write(`\n  ${connected} agent(s) running. Press Ctrl+C to stop.\n`);
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
    await Promise.allSettled(this.agents.map((a) => a.slot.stop()));
    await this.connection.disconnect();
  }

  private scanForNewAgents(agentsDir: string): void {
    try {
      const all = loadAgents({ schema: agentConfigSchema, agentsDir });
      for (const [name, config] of all) {
        if (this.agentNames.has(name)) continue;
        if (this.agentIds.has(config.agentId)) continue;

        process.stderr.write(`\n  New agent detected: ${name}\n`);
        this.addAgent(name, config);
        this.startAgent(name);
      }
    } catch {
      // Ignore transient read errors during file writes
    }
  }

  /**
   * React to an `agent:pinned` server push by writing the local config file
   * (same shape `first-tree-hub agent add` produces) and scheduling the new
   * slot — so the operator doesn't have to run `agent add` manually after
   * creating an agent from the admin UI or API.
   */
  private handleAgentPinned(message: AgentPinnedMessage): void {
    // Skip if we already track this agentId — avoids double-registration when
    // the user also ran `agent add` manually, or when the server re-fires on
    // reconnect in the future.
    if (this.agentIds.has(message.agentId)) return;

    if (!this.agentsDir) {
      process.stderr.write(
        `  \u26A0\uFE0F  Agent pinned (${message.agentId}) but no agents dir set — cannot auto-register.\n`,
      );
      return;
    }

    const localName = this.pickLocalName(message);
    const agentDir = join(this.agentsDir, localName);
    try {
      mkdirSync(agentDir, { recursive: true, mode: 0o700 });
      writeFileSync(join(agentDir, "agent.yaml"), `agentId: "${message.agentId}"\nruntime: claude-code\n`, {
        mode: 0o600,
      });
      process.stderr.write(`  \u2713 Auto-added agent "${localName}" (${message.agentId}) from server push.\n`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`  \u2717 Failed to auto-add agent "${localName}": ${msg}\n`);
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
   * already claimed; otherwise fall back to a deterministic UUID-derived name
   * so collisions with an existing local alias don't silently overwrite.
   */
  private pickLocalName(message: AgentPinnedMessage): string {
    const preferred = message.name;
    if (preferred && !this.agentNames.has(preferred)) return preferred;
    const shortId = message.agentId
      .replace(/[^a-z0-9]/gi, "")
      .slice(0, 8)
      .toLowerCase();
    return `agent-${shortId}`;
  }

  private startAgent(name: string): void {
    const entry = this.agents.find((a) => a.name === name);
    if (!entry) return;
    entry.slot
      .start()
      .then((identity) => {
        process.stderr.write(`  \u2713 ${name}: connected (agent: ${identity.displayName ?? identity.agentId})\n`);
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`  \u2717 ${name}: connection failed \u2014 ${msg}\n`);
      });
  }
}
