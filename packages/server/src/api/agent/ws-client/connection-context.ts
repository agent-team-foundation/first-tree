import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { agents } from "../../../db/schema/agents.js";
import * as agentRuntimeSwitchService from "../../../services/agent-runtime-switch.js";
import * as connectionManager from "../../../services/connection-manager.js";
import type { Notifier } from "../../../services/notifier.js";

export type AuthenticatedSession = {
  userId: string;
};

export type BoundAgentInfo = {
  agentId: string;
  inboxId: string;
  organizationId: string;
  runtimeProvider: string;
};

type ConnectionLifecycleHooks = {
  clearInboxAgent(agentId: string): void;
  clearInboxState(): void;
};

export type ClientWsConnectionContext = ReturnType<typeof createClientWsConnectionContext>;

export function createClientWsConnectionContext(
  app: FastifyInstance,
  socket: WebSocket,
  notifier: Notifier,
  hooks: ConnectionLifecycleHooks,
) {
  let session: AuthenticatedSession | null = null;
  let jwtDefaultOrgId: string | null = null;
  let clientId: string | null = null;
  let authTimeout: NodeJS.Timeout | null = null;
  let authExpiryTimer: NodeJS.Timeout | null = null;
  const boundAgents = new Map<string, BoundAgentInfo>();

  function getSession(): AuthenticatedSession | null {
    return session;
  }

  function authenticate(nextSession: AuthenticatedSession, defaultOrgId: string | null): void {
    session = nextSession;
    jwtDefaultOrgId = defaultOrgId;
  }

  function getJwtDefaultOrgId(): string | null {
    return jwtDefaultOrgId;
  }

  function getClientId(): string | null {
    return clientId;
  }

  function setClientId(nextClientId: string): void {
    clientId = nextClientId;
  }

  function getBoundAgent(agentId: string): BoundAgentInfo | undefined {
    return boundAgents.get(agentId);
  }

  function hasBoundAgent(agentId: string): boolean {
    return boundAgents.has(agentId);
  }

  function bindLocalAgent(info: BoundAgentInfo): void {
    boundAgents.set(info.agentId, info);
  }

  function forgetLocalAgent(agentId: string): void {
    boundAgents.delete(agentId);
  }

  function boundAgentIds(): string[] {
    return [...boundAgents.keys()];
  }

  function boundAgentValues(): BoundAgentInfo[] {
    return [...boundAgents.values()];
  }

  function isAgentStillRoutedHere(agentId: string): boolean {
    return boundAgents.has(agentId) && clientId !== null && connectionManager.getAgentClientId(agentId) === clientId;
  }

  function dropLocalAgentBinding(agentId: string, reason: string): void {
    const info = boundAgents.get(agentId);
    if (info) notifier.unsubscribe(info.inboxId, socket);
    boundAgents.delete(agentId);
    hooks.clearInboxAgent(agentId);
    if (clientId) connectionManager.unbindAgentFromClient(agentId, clientId);
    app.log.info({ clientId, agentId, reason }, "dropped stale local agent binding");
  }

  async function ensureAgentStillRoutedHere(agentId: string): Promise<boolean> {
    if (!isAgentStillRoutedHere(agentId)) return false;
    const info = boundAgents.get(agentId);
    if (!info || !clientId) return false;
    const [row] = await app.db
      .select({
        clientId: agents.clientId,
        runtimeProvider: agents.runtimeProvider,
        status: agents.status,
        metadata: agents.metadata,
      })
      .from(agents)
      .where(eq(agents.uuid, agentId))
      .limit(1);
    if (row?.clientId === clientId && row.status === "active" && row.runtimeProvider === info.runtimeProvider) {
      return true;
    }
    const switchClaim = agentRuntimeSwitchService.getRuntimeSwitchClaim(row?.metadata);
    if (
      row?.status === "suspended" &&
      switchClaim?.phase === "claimed" &&
      switchClaim.oldClientId === clientId &&
      switchClaim.oldRuntimeProvider === info.runtimeProvider
    ) {
      return false;
    }
    dropLocalAgentBinding(agentId, "authoritative_route_changed");
    return false;
  }

  function setAuthTimeout(timer: NodeJS.Timeout): void {
    if (authTimeout) clearTimeout(authTimeout);
    authTimeout = timer;
  }

  function clearAuthTimeout(): void {
    if (!authTimeout) return;
    clearTimeout(authTimeout);
    authTimeout = null;
  }

  function setAuthExpiryTimer(timer: NodeJS.Timeout | null): void {
    if (authExpiryTimer) clearTimeout(authExpiryTimer);
    authExpiryTimer = timer;
  }

  function close(): void {
    clearAuthTimeout();
    setAuthExpiryTimer(null);
    for (const info of boundAgents.values()) notifier.unsubscribe(info.inboxId, socket);
    boundAgents.clear();
    hooks.clearInboxState();
    if (clientId) connectionManager.removeClientConnection(clientId, socket);
  }

  return {
    getSession,
    authenticate,
    getJwtDefaultOrgId,
    getClientId,
    setClientId,
    getBoundAgent,
    hasBoundAgent,
    bindLocalAgent,
    forgetLocalAgent,
    boundAgentIds,
    boundAgentValues,
    isAgentStillRoutedHere,
    ensureAgentStillRoutedHere,
    setAuthTimeout,
    clearAuthTimeout,
    setAuthExpiryTimer,
    close,
  };
}
