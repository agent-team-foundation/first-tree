import type { Database } from "./db/connection.js";
import type { UserScope } from "./scope/types.js";
import type { AdapterManager } from "./services/adapter-manager.js";
import type { ConfigService } from "./services/config-service.js";
import type { Notifier } from "./services/notifier.js";

export type AgentIdentity = {
  uuid: string;
  name: string | null;
  organizationId: string;
  inboxId: string;
};

declare module "fastify" {
  interface FastifyInstance {
    db: Database;
    config: import("./config.js").Config;
    adapterManager: AdapterManager;
    notifier: Notifier;
    configService: ConfigService;
    /** Command-package version advertised via the `server:welcome` WS frame. */
    commandVersion: string;
  }
  interface FastifyRequest {
    agent?: AgentIdentity;
    /** JWT-verified user identity. Populated by `userAuthHook`. */
    user?: UserScope;
  }
}
