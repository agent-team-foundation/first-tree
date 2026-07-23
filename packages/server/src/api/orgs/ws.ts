import { randomBytes } from "node:crypto";
import {
  ADMIN_WS_PROTOCOL_VERSION,
  AGENT_STATUSES,
  AGENT_VISIBILITY,
  type AgentChatStatus,
  AUTH_REJECTED_CODES,
  AUTH_RETRYABLE_CODES,
  type AuthControlFrame,
  type AuthRejectedCode,
  type AuthRetryableCode,
  adminWsAuthFrameSchema,
  WS_AUTH_FRAME_TIMEOUT_MS,
} from "@first-tree/shared";
import { and, eq, ne, or } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { errors, jwtVerify } from "jose";
import type { RawData, WebSocket } from "ws";
import type { Database } from "../../db/connection.js";
import { agents } from "../../db/schema/agents.js";
import { members } from "../../db/schema/members.js";
import { users } from "../../db/schema/users.js";
import {
  createLogger,
  endWsConnectionSpan,
  setWsConnectionAttrs,
  startWsConnectionSpan,
} from "../../observability/index.js";
import { registerAdminBroadcaster } from "../../services/admin-broadcast.js";
import { getChatAgentStatuses } from "../../services/agent-chat-status.js";
import { getCachedAudience } from "../../services/chat-audience-cache.js";
import type { Notifier } from "../../services/notifier.js";
import { configuredServerAuthority } from "../../utils/server-authority.js";

const log = createLogger("OrgWs");
const ADMIN_AUTH_FRAME_MAX_BYTES = 16 * 1024;
const ADMIN_WS_AUTH_EXPIRED_CLOSE_CODE = 4001;
const ADMIN_WS_AUTH_REJECTED_CLOSE_CODE = 4401;
const ADMIN_WS_FORBIDDEN_CLOSE_CODE = 4403;
const ADMIN_WS_RETRYABLE_CLOSE_CODE = 1013;

function parseAdminAuthFrame(raw: RawData, isBinary: boolean, expectedNonce: string): { token: string } | null {
  if (isBinary) return null;
  let bytes: Buffer;
  if (raw instanceof ArrayBuffer) {
    bytes = Buffer.from(raw);
  } else if (Array.isArray(raw)) {
    bytes = Buffer.concat(raw);
  } else {
    bytes = raw;
  }
  if (bytes.byteLength === 0 || bytes.byteLength > ADMIN_AUTH_FRAME_MAX_BYTES) return null;
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    return null;
  }
  const parsed = adminWsAuthFrameSchema.safeParse(value);
  return parsed.success && parsed.data.nonce === expectedNonce ? { token: parsed.data.token } : null;
}

/**
 * Class B — `/api/v1/orgs/:orgId/ws`. Real-time admin push channel.
 * Org is taken from the path; JWT only needs `sub`. Membership in the
 * target org is probed in real time on every handshake — a revoked
 * membership refuses immediately.
 */

type SocketMeta = {
  organizationId: string;
  memberId: string;
  humanAgentId: string;
  visibleAgentIds: Set<string>;
};

async function loadVisibleAgentIds(db: Database, organizationId: string, memberId: string): Promise<Set<string>> {
  const rows = await db
    .select({ id: agents.uuid })
    .from(agents)
    .where(
      and(
        eq(agents.organizationId, organizationId),
        ne(agents.status, AGENT_STATUSES.DELETED),
        or(eq(agents.visibility, AGENT_VISIBILITY.ORGANIZATION), eq(agents.managerId, memberId)),
      ),
    );
  return new Set(rows.map((r) => r.id));
}

function filterPulseAgents(agentsMap: Record<string, unknown>, visible: Set<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [agentId, buckets] of Object.entries(agentsMap)) {
    if (visible.has(agentId)) out[agentId] = buckets;
  }
  return out;
}

export function orgWsRoutes(notifier: Notifier, jwtSecret: string) {
  const adminSockets = new Map<WebSocket, SocketMeta>();
  const secret = new TextEncoder().encode(jwtSecret);

  function broadcastOrgScoped(payload: Record<string, unknown>) {
    const orgId = payload.organizationId;
    if (typeof orgId !== "string" || orgId.length === 0) return;

    const isPulseTick = payload.type === "pulse:tick" && typeof payload.agents === "object" && payload.agents !== null;
    const sharedData = isPulseTick ? null : JSON.stringify(payload);

    for (const [ws, meta] of adminSockets) {
      if (ws.readyState !== 1 || meta.organizationId !== orgId) continue;
      if (isPulseTick) {
        const filtered = filterPulseAgents(payload.agents as Record<string, unknown>, meta.visibleAgentIds);
        ws.send(JSON.stringify({ ...payload, agents: filtered }));
      } else {
        ws.send(sharedData as string);
      }
    }
  }

  registerAdminBroadcaster(broadcastOrgScoped);

  notifier.onSessionStateChange((payload) => {
    void dispatchSessionFrame("session:state", payload);
  });

  notifier.onSessionEvent((payload) => {
    void dispatchSessionFrame("session:event", payload);
  });

  notifier.onSessionRuntime((payload) => {
    // Same shape as session:state — a per-(agent,chat) flip whose composite
    // status the audience patches in place. Audience filter is the same
    // (status carries narration via the freshly-recomputed activity).
    void dispatchSessionFrame("session:runtime", payload);
  });

  notifier.onChatMessage(({ chatId }) => {
    void dispatchChatMessage(chatId);
  });

  notifier.onChatUpdated(({ chatId }) => {
    void dispatchChatUpdated(chatId);
  });

  notifier.onMeChatsChanged(({ humanAgentId, organizationId }) => {
    dispatchMeChatsChanged(humanAgentId, organizationId);
  });

  /**
   * Deliver a session:state / session:event / session:runtime frame. The
   * recomputed agent status carries the agent's narration (activity.detail
   * / turnText), so it is attached ONLY for sockets whose viewer can access
   * the chat — NEVER sent org-wide. Audience members get the enriched frame
   * and patch `["chat-agent-status", chatId]` in place; every other org
   * socket gets the bare routing frame (invalidate-only). Computed once per
   * NOTIFY, only while admin sockets are connected.
   *
   * `session:runtime` rides on the same path as `session:state` because
   * they are semantically siblings — both signal "a per-(agent,chat)
   * composite axis flipped", just on different axes (lifecycle vs D-axis
   * runtime). Sharing the path keeps the web cache reconciliation
   * deterministic (one in-place patch, no invalidate races).
   */
  async function dispatchSessionFrame(
    type: "session:state" | "session:event" | "session:runtime",
    payload: { agentId: string; chatId: string; organizationId: string } & Record<string, unknown>,
  ): Promise<void> {
    if (adminSockets.size === 0) return;
    let status: AgentChatStatus | undefined;
    let audience: ReadonlySet<string> | null = null;
    try {
      const db = getDbForChatLookup();
      audience = await getCachedAudience(db, payload.chatId);
      if (audience && audience.size > 0) {
        status = (await getChatAgentStatuses(db, payload.chatId)).find((s) => s.agentId === payload.agentId);
      }
    } catch (err) {
      // Best-effort enrichment: on any failure fall back to the bare frame
      // everywhere (the client's invalidate path + refetch floor still cover it).
      // Logged (not silent) so a sustained DB hiccup that degrades the realtime
      // delta to refetch-latency is visible rather than invisible.
      log.warn({ err, chatId: payload.chatId, agentId: payload.agentId }, "session-frame status enrichment failed");
      status = undefined;
    }
    const bareFrame = JSON.stringify({ type, ...payload });
    const enrichedFrame = status ? JSON.stringify({ type, ...payload, status }) : bareFrame;
    for (const [ws, meta] of adminSockets) {
      if (ws.readyState !== 1 || meta.organizationId !== payload.organizationId) continue;
      const frame = status && audience?.has(meta.humanAgentId) ? enrichedFrame : bareFrame;
      try {
        ws.send(frame);
      } catch {
        // socket-level errors surface via close handler
      }
    }
  }

  async function dispatchChatMessage(chatId: string): Promise<void> {
    if (adminSockets.size === 0) return;
    const audience = await getCachedAudience(getDbForChatLookup(), chatId);
    if (!audience || audience.size === 0) return;
    const frame = JSON.stringify({ type: "chat:message", chatId });
    for (const [ws, meta] of adminSockets) {
      if (ws.readyState !== 1) continue;
      if (!audience.has(meta.humanAgentId)) continue;
      try {
        ws.send(frame);
      } catch {
        // socket-level errors surface via close handler
      }
    }
  }

  // Metadata-change sibling of dispatchChatMessage: same chat-audience gate, but
  // emits a `chat:updated` frame (no messageId) so clients refresh chat-detail +
  // the conversation list without touching the message timeline.
  async function dispatchChatUpdated(chatId: string): Promise<void> {
    if (adminSockets.size === 0) return;
    const audience = await getCachedAudience(getDbForChatLookup(), chatId);
    if (!audience || audience.size === 0) return;
    const frame = JSON.stringify({ type: "chat:updated", chatId });
    for (const [ws, meta] of adminSockets) {
      if (ws.readyState !== 1) continue;
      if (!audience.has(meta.humanAgentId)) continue;
      try {
        ws.send(frame);
      } catch {
        // socket-level errors surface via close handler
      }
    }
  }

  // Per-USER sibling of dispatchChatUpdated: a private me-chats change (pin /
  // unpin) fans a bare `me-chats:changed` invalidation to ONLY the acting
  // user's own sockets in that org. Deliberately NO chat-audience lookup — pin
  // state is private and must never reach another member's devices, so the gate
  // is identity (`humanAgentId`) + org, not chat membership. One user with two
  // devices in the org sees both rails regroup; nobody else is touched. Sync
  // (no DB), so it runs inline on the notifier callback.
  function dispatchMeChatsChanged(humanAgentId: string, organizationId: string): void {
    if (adminSockets.size === 0) return;
    const frame = JSON.stringify({ type: "me-chats:changed" });
    for (const [ws, meta] of adminSockets) {
      if (ws.readyState !== 1) continue;
      if (meta.humanAgentId !== humanAgentId || meta.organizationId !== organizationId) continue;
      try {
        ws.send(frame);
      } catch {
        // socket-level errors surface via close handler
      }
    }
  }

  let cachedDbForChatLookup: Database | null = null;
  function getDbForChatLookup(): Database {
    if (!cachedDbForChatLookup) throw new Error("admin WS: db not initialised yet");
    return cachedDbForChatLookup;
  }
  function rememberDb(db: Database): void {
    if (!cachedDbForChatLookup) cachedDbForChatLookup = db;
  }

  return async (app: FastifyInstance): Promise<void> => {
    const serverAuthority = configuredServerAuthority(app.config);

    app.get<{ Params: { orgId: string } }>("/", { websocket: true }, async (socket, request) => {
      const ua = request.headers["user-agent"];
      startWsConnectionSpan(socket, {
        remoteIp: request.ip,
        userAgent: typeof ua === "string" ? ua.slice(0, 200) : undefined,
      });

      const orgIdFromPath = (request.params as { orgId?: string }).orgId;
      if (!orgIdFromPath) {
        socket.send(
          JSON.stringify({
            type: "auth:rejected",
            code: AUTH_REJECTED_CODES.INVALID_CLAIMS,
            message: "Missing org",
          }),
        );
        socket.close(ADMIN_WS_AUTH_REJECTED_CLOSE_CODE, "Missing org");
        endWsConnectionSpan(socket, ADMIN_WS_AUTH_REJECTED_CLOSE_CODE);
        return;
      }

      let authTimeout: ReturnType<typeof setTimeout> | null = null;
      let tokenExpiryTimeout: ReturnType<typeof setTimeout> | null = null;
      let authenticated = false;
      let handshakeSettled = false;
      let socketClosed = false;
      const challengeNonce = randomBytes(16).toString("base64url");
      const clearAuthTimeout = (): void => {
        if (authTimeout !== null) {
          clearTimeout(authTimeout);
          authTimeout = null;
        }
      };
      const clearTokenExpiryTimeout = (): void => {
        if (tokenExpiryTimeout !== null) {
          clearTimeout(tokenExpiryTimeout);
          tokenExpiryTimeout = null;
        }
      };
      const sendControlAndClose = (frame: AuthControlFrame, closeCode: number, reason: string): void => {
        if (socketClosed) return;
        clearAuthTimeout();
        clearTokenExpiryTimeout();
        socket.send(JSON.stringify(frame));
        socket.close(closeCode, reason);
      };
      const rejectAuth = (
        message: string,
        reason: string,
        code: AuthRejectedCode = AUTH_REJECTED_CODES.INVALID_TOKEN,
        closeCode = ADMIN_WS_AUTH_REJECTED_CLOSE_CODE,
      ): void => {
        if (handshakeSettled) return;
        handshakeSettled = true;
        sendControlAndClose({ type: "auth:rejected", code, message }, closeCode, reason);
      };
      const retryAuth = (message: string, reason: string, code: AuthRetryableCode): void => {
        if (handshakeSettled) return;
        handshakeSettled = true;
        sendControlAndClose(
          { type: "auth:retryable", code, message, retryAfterMs: 2_000 },
          ADMIN_WS_RETRYABLE_CLOSE_CODE,
          reason,
        );
      };
      const expireAuth = (): void => {
        if (socketClosed) return;
        handshakeSettled = true;
        sendControlAndClose({ type: "auth:expired" }, ADMIN_WS_AUTH_EXPIRED_CLOSE_CODE, "Auth expired");
      };

      socket.on("close", (code) => {
        socketClosed = true;
        handshakeSettled = true;
        clearAuthTimeout();
        clearTokenExpiryTimeout();
        adminSockets.delete(socket);
        endWsConnectionSpan(socket, code);
      });

      socket.once("message", (raw: RawData, isBinary: boolean) => {
        const frame = parseAdminAuthFrame(raw, isBinary, challengeNonce);
        if (!frame) {
          rejectAuth("Invalid authentication frame", "Invalid auth frame", "invalid_auth_frame");
          return;
        }
        void (async () => {
          let userId: string;
          let expiresAtMs: number;
          try {
            const { payload } = await jwtVerify(frame.token, secret);
            if (handshakeSettled) return;
            if (payload.type !== "access") {
              rejectAuth("Invalid token type", "Invalid token", AUTH_REJECTED_CODES.WRONG_TOKEN_TYPE);
              return;
            }
            if (
              typeof payload.sub !== "string" ||
              payload.sub.length === 0 ||
              typeof payload.exp !== "number" ||
              !Number.isSafeInteger(payload.exp)
            ) {
              rejectAuth("Invalid token claims", "Invalid claims", AUTH_REJECTED_CODES.INVALID_CLAIMS);
              return;
            }
            userId = payload.sub;
            expiresAtMs = payload.exp * 1_000;
            if (expiresAtMs <= Date.now()) {
              expireAuth();
              return;
            }
          } catch (error) {
            if (error instanceof errors.JWTExpired) {
              expireAuth();
              return;
            }
            if (error instanceof errors.JWTClaimValidationFailed) {
              rejectAuth("Invalid token claims", "Invalid claims", AUTH_REJECTED_CODES.INVALID_CLAIMS);
              return;
            }
            rejectAuth("Invalid token", "Auth failed", AUTH_REJECTED_CODES.INVALID_TOKEN);
            return;
          }

          const organizationId = orgIdFromPath;
          const [userRow] = await app.db
            .select({ id: users.id, status: users.status })
            .from(users)
            .where(eq(users.id, userId))
            .limit(1);
          if (handshakeSettled) return;
          if (!userRow) {
            rejectAuth("User not found or suspended", "User not found", AUTH_REJECTED_CODES.USER_NOT_FOUND);
            return;
          }
          if (userRow.status !== "active") {
            rejectAuth("User not found or suspended", "User suspended", AUTH_REJECTED_CODES.USER_SUSPENDED);
            return;
          }

          const [memberRow] = await app.db
            .select({ id: members.id, role: members.role, agentId: members.agentId })
            .from(members)
            .where(
              and(eq(members.userId, userId), eq(members.organizationId, organizationId), eq(members.status, "active")),
            )
            .limit(1);
          if (handshakeSettled) return;
          if (!memberRow) {
            rejectAuth(
              "Not an active member of this organization",
              "Not a member",
              AUTH_REJECTED_CODES.INVALID_CLAIMS,
              ADMIN_WS_FORBIDDEN_CLOSE_CODE,
            );
            return;
          }
          const memberId = memberRow.id;

          setWsConnectionAttrs(socket, { organizationId, memberId });
          rememberDb(app.db);

          const visibleAgentIds = await loadVisibleAgentIds(app.db, organizationId, memberId);
          if (handshakeSettled) return;
          const [humanAgentRow] = await app.db
            .select({ uuid: agents.uuid })
            .from(agents)
            .where(eq(agents.uuid, memberRow.agentId))
            .limit(1);
          if (handshakeSettled) return;
          const humanAgentId = humanAgentRow?.uuid ?? memberRow.agentId;

          if (expiresAtMs <= Date.now()) {
            expireAuth();
            return;
          }
          socket.send(
            JSON.stringify({
              type: "auth:ok",
              protocolVersion: ADMIN_WS_PROTOCOL_VERSION,
              nonce: challengeNonce,
            }),
          );
          handshakeSettled = true;
          authenticated = true;
          clearAuthTimeout();
          adminSockets.set(socket, { organizationId, memberId, humanAgentId, visibleAgentIds });
          tokenExpiryTimeout = setTimeout(expireAuth, expiresAtMs - Date.now());
        })().catch((error) => {
          if (handshakeSettled) return;
          app.log.warn({ err: error }, "admin websocket authentication failed");
          retryAuth(
            "Authentication backend unavailable",
            "Auth unavailable",
            AUTH_RETRYABLE_CODES.AUTH_BACKEND_UNAVAILABLE,
          );
        });
      });

      authTimeout = setTimeout(() => {
        if (authenticated) return;
        retryAuth("Authentication timed out", "Auth timeout", AUTH_RETRYABLE_CODES.AUTH_TIMEOUT);
      }, WS_AUTH_FRAME_TIMEOUT_MS);
      socket.send(
        JSON.stringify({
          type: "server:hello",
          protocolVersion: ADMIN_WS_PROTOCOL_VERSION,
          authority: serverAuthority,
          nonce: challengeNonce,
        }),
      );
    });
  };
}
