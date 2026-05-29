import type { Database } from "./db/connection.js";
import type { UserScope } from "./scope/types.js";
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
    notifier: Notifier;
    configService: ConfigService;
    /**
     * Command-package version advertised via the `server:welcome` WS frame.
     * Exposed as a getter so the npm-registry poller can refresh the value
     * without re-decorating the Fastify instance. Call it on the hot WS path
     * — it's a synchronous in-memory read.
     */
    commandVersion: () => string;
  }
  interface FastifyRequest {
    agent?: AgentIdentity;
    /** JWT-verified user identity. Populated by `userAuthHook`. */
    user?: UserScope;
  }
}
