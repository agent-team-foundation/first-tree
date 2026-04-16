import type { FSWatcher } from "node:fs";
import { existsSync, watch } from "node:fs";
import type { AgentConfig } from "@agent-team-foundation/first-tree-hub-shared/config";
import { agentConfigSchema, loadAgents } from "@agent-team-foundation/first-tree-hub-shared/config";
import {
  type AgentProvision,
  AgentSlot,
  ClientConnection,
  getHandlerFactory,
  registerBuiltinHandlers,
} from "@first-tree-hub/client";
import { saveAgentConfig } from "./bootstrap.js";

type AgentEntry = {
  name: string;
  slot: AgentSlot;
};

/**
 * Client runtime — one shared ClientConnection, multiple agents multiplexed.
 *
 * Lifecycle:
 *   1. start() → ClientConnection.connect() (registers client on server)
 *   2. For each agent: AgentSlot.start() → bindAgent() through shared connection
 *   3. watchAgentsDir() → hot-add new agents via file watch
 *   4. Server-pushed agent:provision → auto-save config + bind
 *   5. stop() → unbind all agents, close connection
 */
export class ClientRuntime {
  private readonly serverUrl: string;
  private readonly connection: ClientConnection;
  private readonly agents: AgentEntry[] = [];
  private readonly agentNames = new Set<string>();
  private watcher: FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(serverUrl: string) {
    this.serverUrl = serverUrl;
    this.connection = new ClientConnection({ serverUrl });
    registerBuiltinHandlers();

    // Listen for server-pushed agent provisioning
    this.connection.on("agent:provision", (provision) => {
      this.handleProvision(provision);
    });
  }

  /** Add an agent to manage. Config includes type, concurrency, session settings. */
  addAgent(name: string, config: AgentConfig): void {
    if (this.agentNames.has(name)) return;
    const handlerFactory = getHandlerFactory(config.runtime);
    const slot = new AgentSlot({
      name,
      serverUrl: this.serverUrl,
      token: config.token,
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
  }

  /** Connect to server and start all agents. */
  async start(): Promise<void> {
    // 1. Establish client connection (registers client on server)
    await this.connection.connect();
    process.stderr.write(`  \u2713 Client registered: ${this.connection.clientId}\n`);

    // 2. Bind agents (if any)
    if (this.agents.length === 0) {
      process.stderr.write("\n  No agents configured yet.\n");
      process.stderr.write("  Add one with: first-tree-hub agent create <name> --type claude-code\n\n");
      return;
    }

    for (const agent of this.agents) {
      try {
        const identity = await agent.slot.start();
        process.stderr.write(
          `  \u2713 ${agent.name}: connected (agent: ${identity.displayName ?? identity.agentId})\n`,
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        process.stderr.write(`  \u2717 ${agent.name}: connection failed \u2014 ${msg}\n`);
      }
    }

    const connected = this.agents.length;
    process.stderr.write(`\n  ${connected} agent(s) running. Press Ctrl+C to stop.\n`);
  }

  /** Watch agents config directory for new agent configs. Hot-add on detection. */
  watchAgentsDir(agentsDir: string): void {
    if (this.watcher) return;
    if (!existsSync(agentsDir)) return;

    this.watcher = watch(agentsDir, { recursive: true }, () => {
      // Debounce: file writes may trigger multiple events
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => {
        this.debounceTimer = null;
        this.scanForNewAgents(agentsDir);
      }, 500);
    });
  }

  /** Stop watching agents config directory. */
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

  /** Stop all agent connections and close client connection. */
  async stop(): Promise<void> {
    this.unwatchAgentsDir();
    await Promise.allSettled(this.agents.map((a) => a.slot.stop()));
    await this.connection.disconnect();
  }

  /** Handle server-pushed agent provisioning: save config and bind. */
  private handleProvision(provision: AgentProvision): void {
    const { agentName, agentType, token } = provision;
    if (this.agentNames.has(agentName)) {
      process.stderr.write(`\n  Agent "${agentName}" already configured, skipping provision.\n`);
      return;
    }

    process.stderr.write(`\n  Provisioned by Hub: ${agentName} (${agentType})\n`);

    // Human agents are identity-only; skip runtime config and handler
    if (agentType === "human") {
      process.stderr.write(`  - ${agentName}: human agent — no runtime needed\n`);
      return;
    }

    // Save agent config to disk — runtime defaults to claude-code
    const runtime = "claude-code";
    saveAgentConfig(agentName, token, runtime);

    // Create slot and start
    const config: AgentConfig = {
      token,
      runtime,
      session: { idle_timeout: 1800, max_sessions: 3 },
      concurrency: 1,
    };
    this.addAgent(agentName, config);
    this.startAgent(agentName);
  }

  /** Scan for newly added agent configs and start them. */
  private scanForNewAgents(agentsDir: string): void {
    try {
      const all = loadAgents({ schema: agentConfigSchema, agentsDir });
      for (const [name, config] of all) {
        if (this.agentNames.has(name)) continue;

        process.stderr.write(`\n  New agent detected: ${name}\n`);
        this.addAgent(name, config);
        this.startAgent(name);
      }
    } catch {
      // Ignore transient read errors during file writes
    }
  }

  /** Start a named agent slot asynchronously with logging. */
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
