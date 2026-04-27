import type { Database } from "./db/connection.js";
import type { AdapterManager } from "./services/adapter-manager.js";
import type { ConfigService } from "./services/config-service.js";
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

/**
 * Authenticated identity from a "rootless" `type: "user"` JWT — populated by
 * `userAuthHook` for routes that exist before a user has picked / created a
 * workspace (`/me`, `/me/workspaces*`, `/auth/switch-org`). Routes that
 * require an org context use `request.member` from `memberAuthHook` instead.
 */
export type AuthedUser = {
  userId: string;
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
    member?: MemberIdentity;
    authedUser?: AuthedUser;
  }
}
