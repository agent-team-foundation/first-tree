import { AgentHubSDK } from "@agent-hub/client";
import type { AgentConfig } from "@agent-hub/shared/config";

type AgentInstance = {
  name: string;
  sdk: AgentHubSDK;
  pollTimer: ReturnType<typeof setInterval> | null;
  connected: boolean;
};

/**
 * Client runtime — manages multiple agent connections to a single server.
 */
export class ClientRuntime {
  private readonly serverUrl: string;
  private readonly agents: Map<string, AgentInstance> = new Map();
  private running = false;

  constructor(serverUrl: string) {
    this.serverUrl = serverUrl;
  }

  /** Add an agent to manage. */
  addAgent(name: string, config: AgentConfig): void {
    const sdk = new AgentHubSDK({
      serverUrl: this.serverUrl,
      token: config.token,
    });
    this.agents.set(name, { name, sdk, pollTimer: null, connected: false });
  }

  /** Start all agent connections. */
  async start(): Promise<void> {
    this.running = true;

    for (const [name, agent] of this.agents) {
      try {
        // Verify token is valid
        const identity = await agent.sdk.register();
        agent.connected = true;
        process.stderr.write(`  ✓ ${name}: connected (agent: ${identity.displayName ?? identity.agentId})\n`);

        // Start polling inbox
        agent.pollTimer = setInterval(() => {
          void this.pollAgent(agent);
        }, 5000);

        // Initial poll
        void this.pollAgent(agent);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        process.stderr.write(`  ✗ ${name}: connection failed — ${msg}\n`);
      }
    }

    const connected = [...this.agents.values()].filter((a) => a.connected).length;
    process.stderr.write(`\n  ${connected}/${this.agents.size} agent(s) running. Press Ctrl+C to stop.\n`);
  }

  /** Stop all agent connections. */
  stop(): void {
    this.running = false;
    for (const agent of this.agents.values()) {
      if (agent.pollTimer) {
        clearInterval(agent.pollTimer);
        agent.pollTimer = null;
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

  private async pollAgent(agent: AgentInstance): Promise<void> {
    if (!this.running) return;
    try {
      const result = await agent.sdk.pull(10);
      for (const entry of result.entries) {
        // Log received messages (P1: basic — future: route to agent session)
        const msg = entry.message;
        process.stderr.write(`  [${agent.name}] inbox: ${msg.format} from ${msg.senderId} in chat ${msg.chatId}\n`);
        // Auto-ack for now
        await agent.sdk.ack(entry.id);
      }
    } catch (error) {
      if (!this.running) return;
      const msg = error instanceof Error ? error.message : String(error);
      process.stderr.write(`  [${agent.name}] poll error: ${msg}\n`);
    }
  }
}
