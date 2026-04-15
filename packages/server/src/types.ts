import type { Database } from "./db/connection.js";
import type { AdapterManager } from "./services/adapter-manager.js";
import type { Notifier } from "./services/notifier.js";

export type AgentIdentity = {
  uuid: string;
  name: string | null;
  organizationId: string;
  inboxId: string;
};

export type MemberIdentity = {
  userId: string;
  memberId: string;
  organizationId: string;
  role: string;
  agentId: string;
};

export type GitHubUserIdentity = {
  username: string;
};

declare module "fastify" {
  interface FastifyInstance {
    db: Database;
    config: import("./config.js").Config;
    adapterManager: AdapterManager;
    notifier: Notifier;
  }
  interface FastifyRequest {
    agent?: AgentIdentity;
    member?: MemberIdentity;
    githubUser?: GitHubUserIdentity;
  }
}
