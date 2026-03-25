import { AgentConnection } from "@agent-hub/client";
import type { AgentConfig } from "@agent-hub/shared/config";

type AgentInstance = {
  name: string;
  connection: AgentConnection;
  connected: boolean;
};

/**
 * Client runtime — manages multiple agent connections to a single server.
 * Uses WebSocket-based AgentConnection for real-time message delivery.
 */
export class ClientRuntime {
  private readonly serverUrl: string;
  private readonly agents: Map<string, AgentInstance> = new Map();

  constructor(serverUrl: string) {
    this.serverUrl = serverUrl;
  }

  /** Add an agent to manage. */
  addAgent(name: string, config: AgentConfig): void {
    const connection = new AgentConnection({
      serverUrl: this.serverUrl,
      token: config.token,
    });
    this.agents.set(name, { name, connection, connected: false });
  }

  /** Start all agent connections. */
  async start(): Promise<void> {
    for (const [name, agent] of this.agents) {
      try {
        agent.connection.on("error", (err) => {
          process.stderr.write(`  [${name}] error: ${err.message}\n`);
        });
        agent.connection.on("reconnecting", (attempt) => {
          process.stderr.write(`  [${name}] reconnecting (attempt ${attempt})...\n`);
        });

        // Register message handler — log and auto-ack for now
        agent.connection.onMessage(async (entry) => {
          const msg = entry.message;
          process.stderr.write(`  [${name}] inbox: ${msg.format} from ${msg.senderId} in chat ${msg.chatId}\n`);
          await agent.connection.sdk.ack(entry.id);
        });

        const identity = await agent.connection.connect();
        agent.connected = true;
        process.stderr.write(`  \u2713 ${name}: connected (agent: ${identity.displayName ?? identity.agentId})\n`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        process.stderr.write(`  \u2717 ${name}: connection failed \u2014 ${msg}\n`);
      }
    }

    const connected = [...this.agents.values()].filter((a) => a.connected).length;
    process.stderr.write(`\n  ${connected}/${this.agents.size} agent(s) running. Press Ctrl+C to stop.\n`);
  }

  /** Stop all agent connections. */
  async stop(): Promise<void> {
    for (const agent of this.agents.values()) {
      if (agent.connected) {
        await agent.connection.disconnect();
      }
      agent.connected = false;
    }
  }

  /** Get status of all agents. */
  getStatus(): Array<{ name: string; connected: boolean }> {
    return [...this.agents.entries()].map(([name, agent]) => ({
      name,
      connected: agent.connected,
    }));
  }
}
