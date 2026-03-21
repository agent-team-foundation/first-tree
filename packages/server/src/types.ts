import type { Database } from "./db/connection.js";

export type AgentIdentity = {
  id: string;
  organizationId: string;
  inboxId: string;
};

export type AdminIdentity = {
  id: string;
  username: string;
  role: string;
};

declare module "fastify" {
  interface FastifyInstance {
    db: Database;
    config: import("./config.js").Config;
  }
  interface FastifyRequest {
    agent?: AgentIdentity;
    admin?: AdminIdentity;
  }
}
