import { AgentSlot, getHandlerFactory, registerBuiltinHandlers } from "@first-tree-core/client";
import type { AgentConfig } from "@first-tree-core/shared/config";

type AgentEntry = {
  name: string;
  slot: AgentSlot;
};

/**
 * Client runtime — manages multiple agent connections via AgentSlot.
 * Each agent runs a full Handler + SessionManager pipeline.
 */
export class ClientRuntime {
  private readonly serverUrl: string;
  private readonly agents: AgentEntry[] = [];

  constructor(serverUrl: string) {
    this.serverUrl = serverUrl;
    registerBuiltinHandlers();
  }

  /** Add an agent to manage. Config includes type, concurrency, session settings. */
  addAgent(name: string, config: AgentConfig): void {
    const handlerFactory = getHandlerFactory(config.type);
    const slot = new AgentSlot({
      name,
      serverUrl: this.serverUrl,
      token: config.token,
      type: config.type,
      handlerFactory,
      session: {
        idle_timeout: config.session.idle_timeout,
        max_sessions: config.session.max_sessions,
      },
      concurrency: config.concurrency,
    });
    this.agents.push({ name, slot });
  }

  /** Start all agent connections with handler pipelines. */
  async start(): Promise<void> {
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

  /** Stop all agent connections gracefully. */
  async stop(): Promise<void> {
    await Promise.allSettled(this.agents.map((a) => a.slot.stop()));
  }
}
