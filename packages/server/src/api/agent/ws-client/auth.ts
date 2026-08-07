import {
  AUTH_REJECTED_CODES,
  AUTH_RETRYABLE_CODES,
  type AuthRejectedCode,
  type AuthRetryableCode,
  WS_AUTH_FRAME_TIMEOUT_MS,
  wsAuthFrameSchema,
} from "@first-tree/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { jwtVerify } from "jose";
import type { WebSocket } from "ws";
import { users } from "../../../db/schema/users.js";
import {
  classifyJoseError,
  decodeJwtForTrace,
  type JwtFailureReason,
  setWsConnectionAttrs,
  untrustedAttrs,
} from "../../../observability/index.js";
import type { ClientWsConnectionContext } from "./connection-context.js";

type WsAuthPhase =
  | "auth_frame_timeout"
  | "auth_frame_validation"
  | "jwt_verify"
  | "claims_validation"
  | "user_lookup"
  | "post_auth_welcome"
  | "client_register";

type WsAuthOutcome = "accepted" | "expired" | "rejected" | "retryable" | "protocol_error";

function sendJsonOrThrow(socket: WebSocket, frame: unknown): void {
  if (socket.readyState !== socket.OPEN) throw new Error("WebSocket is not open");
  socket.send(JSON.stringify(frame));
}

export function setAuthWsAttrs(
  socket: WebSocket,
  attrs: {
    phase: WsAuthPhase;
    outcome: WsAuthOutcome;
    code: string;
    retryable: boolean;
    closeCode?: number;
    errorClass?: string;
    extraAttrs?: Record<string, string | number | boolean>;
  },
): void {
  setWsConnectionAttrs(socket, {
    "auth.ws.phase": attrs.phase,
    "auth.ws.outcome": attrs.outcome,
    "auth.ws.code": attrs.code,
    "auth.ws.retryable": attrs.retryable,
    "auth.ws.close_code": attrs.closeCode,
    ...(attrs.errorClass ? { "auth.ws.error_class": attrs.errorClass } : {}),
    ...(attrs.extraAttrs ?? {}),
  });
}

function closeWithAuthRejected(
  socket: WebSocket,
  phase: WsAuthPhase,
  code: AuthRejectedCode,
  message?: string,
  errorClass?: string,
  extraAttrs?: Record<string, string | number | boolean>,
): void {
  setAuthWsAttrs(socket, {
    phase,
    outcome: "rejected",
    code,
    retryable: false,
    closeCode: 4401,
    errorClass,
    extraAttrs,
  });
  try {
    sendJsonOrThrow(socket, { type: "auth:rejected", code, ...(message ? { message } : {}) });
  } catch {
    // The close below remains idempotent if the peer has already gone away.
  }
  socket.close(4401, "auth rejected");
}

function closeWithAuthExpired(
  socket: WebSocket,
  phase: WsAuthPhase,
  extraAttrs?: Record<string, string | number | boolean>,
  errorClass?: string,
): void {
  setAuthWsAttrs(socket, {
    phase,
    outcome: "expired",
    code: "jwt_expired",
    retryable: true,
    closeCode: 4401,
    extraAttrs,
    errorClass,
  });
  try {
    sendJsonOrThrow(socket, { type: "auth:expired" });
  } catch {
    // The socket may already be gone.
  }
  socket.close(4401, "auth expired");
}

function closeWithAuthRetryable(
  socket: WebSocket,
  phase: WsAuthPhase,
  code: AuthRetryableCode,
  closeCode: 1011 | 1013,
  message?: string,
  errorClass?: string,
): void {
  setAuthWsAttrs(socket, { phase, outcome: "retryable", code, retryable: true, closeCode, errorClass });
  try {
    sendJsonOrThrow(socket, { type: "auth:retryable", code, ...(message ? { message } : {}) });
  } catch {
    // The socket may already be gone.
  }
  socket.close(closeCode, "auth retryable");
}

function joseErrorCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null || !("code" in err)) return undefined;
  const code = err.code;
  return typeof code === "string" ? code : undefined;
}

function rejectedCodeForJoseError(reason: JwtFailureReason, err: unknown): AuthRejectedCode {
  if (joseErrorCode(err) === "ERR_JWT_CLAIM_VALIDATION_FAILED") return AUTH_REJECTED_CODES.INVALID_CLAIMS;
  switch (reason) {
    case "jwt_signature_invalid":
    case "jwt_malformed":
    case "jwt_verify_failed":
    case "jwt_expired":
      return AUTH_REJECTED_CODES.INVALID_TOKEN;
  }
}

export function createClientWsAuthGate(
  app: FastifyInstance,
  socket: WebSocket,
  jwtSecretBytes: Uint8Array,
  context: ClientWsConnectionContext,
) {
  const clearAuthTimeout = context.clearAuthTimeout;
  const rejectAuthAndClose = (
    phase: WsAuthPhase,
    code: AuthRejectedCode,
    message?: string,
    errorClass?: string,
    extraAttrs?: Record<string, string | number | boolean>,
  ) => {
    clearAuthTimeout();
    closeWithAuthRejected(socket, phase, code, message, errorClass, extraAttrs);
  };
  const expireAuthAndCloseWithAttrs = (
    phase: WsAuthPhase,
    extraAttrs?: Record<string, string | number | boolean>,
    errorClass?: string,
  ) => {
    clearAuthTimeout();
    closeWithAuthExpired(socket, phase, extraAttrs, errorClass);
  };
  const retryAuthAndClose = (
    phase: WsAuthPhase,
    code: AuthRetryableCode,
    closeCode: 1011 | 1013,
    message?: string,
    errorClass?: string,
  ) => {
    clearAuthTimeout();
    closeWithAuthRetryable(socket, phase, code, closeCode, message, errorClass);
  };

  function start(): void {
    context.setAuthTimeout(
      setTimeout(() => {
        if (!context.getSession()) {
          retryAuthAndClose("auth_frame_timeout", AUTH_RETRYABLE_CODES.AUTH_TIMEOUT, 1013, "auth frame timeout");
        }
      }, WS_AUTH_FRAME_TIMEOUT_MS),
    );
  }

  function rejectInvalidFrame(message: string): void {
    rejectAuthAndClose("auth_frame_validation", AUTH_REJECTED_CODES.INVALID_AUTH_FRAME, message);
  }

  function scheduleAuthExpiry(expSeconds: number | undefined): void {
    context.setAuthExpiryTimer(null);
    if (!expSeconds) return;
    const delay = expSeconds * 1000 - Date.now();
    if (delay <= 0) return;
    context.setAuthExpiryTimer(setTimeout(() => closeWithAuthExpired(socket, "jwt_verify"), delay));
  }

  async function handle(msg: unknown, type: string): Promise<boolean> {
    if (context.getSession()) return false;
    if (type !== "auth") {
      rejectInvalidFrame("first frame must be auth");
      return true;
    }
    const authParsed = wsAuthFrameSchema.safeParse(msg);
    if (!authParsed.success) {
      rejectInvalidFrame("invalid auth frame");
      return true;
    }

    const token = authParsed.data.token;
    let payload: Awaited<ReturnType<typeof jwtVerify>>["payload"];
    try {
      const verified = await jwtVerify(token, jwtSecretBytes);
      payload = verified.payload;
    } catch (err) {
      const reason = classifyJoseError(err);
      const traceClaims = untrustedAttrs("auth.ws", decodeJwtForTrace(token));
      const errorClass = err instanceof Error ? err.name : reason;
      if (reason === "jwt_expired") {
        expireAuthAndCloseWithAttrs("jwt_verify", traceClaims, errorClass);
        return true;
      }
      rejectAuthAndClose(
        "jwt_verify",
        rejectedCodeForJoseError(reason, err),
        "JWT verification failed",
        errorClass,
        traceClaims,
      );
      return true;
    }

    const tokenType = payload.type;
    if (tokenType !== "access") {
      rejectAuthAndClose(
        "claims_validation",
        tokenType === undefined ? AUTH_REJECTED_CODES.INVALID_CLAIMS : AUTH_REJECTED_CODES.WRONG_TOKEN_TYPE,
        "member access token required",
        tokenType === undefined ? "missing_token_type" : "wrong_token_type",
      );
      return true;
    }
    const userId = payload.sub;
    if (typeof userId !== "string" || userId.length === 0) {
      rejectAuthAndClose(
        "claims_validation",
        AUTH_REJECTED_CODES.INVALID_CLAIMS,
        "missing subject claim",
        "missing_sub",
      );
      return true;
    }

    let user: { id: string; status: string } | undefined;
    try {
      [user] = await app.db
        .select({ id: users.id, status: users.status })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
    } catch (err) {
      app.log.warn({ err, userId }, "WS auth user lookup failed; asking client to retry");
      retryAuthAndClose(
        "user_lookup",
        AUTH_RETRYABLE_CODES.AUTH_BACKEND_UNAVAILABLE,
        1013,
        "authentication backend unavailable",
        err instanceof Error ? err.name : "UnknownError",
      );
      return true;
    }
    if (!user) {
      rejectAuthAndClose("user_lookup", AUTH_REJECTED_CODES.USER_NOT_FOUND, "user not found");
      return true;
    }
    if (user.status !== "active") {
      rejectAuthAndClose("user_lookup", AUTH_REJECTED_CODES.USER_SUSPENDED, "user suspended");
      return true;
    }

    context.authenticate(
      { userId: user.id },
      typeof payload.organizationId === "string" ? payload.organizationId : null,
    );
    setWsConnectionAttrs(socket, { "user.id": user.id });
    clearAuthTimeout();
    scheduleAuthExpiry(payload.exp);

    try {
      sendJsonOrThrow(socket, {
        type: "server:welcome",
        serverCommandVersion: app.commandVersion(),
        serverTimeMs: Date.now(),
        capabilities: {
          wsInboxAckConfirm: true,
          wsSessionEventConfirm: true,
          wsSessionResetV1: true,
        },
      });
      sendJsonOrThrow(socket, { type: "auth:ok" });
      setAuthWsAttrs(socket, {
        phase: "post_auth_welcome",
        outcome: "accepted",
        code: "auth_ok",
        retryable: false,
      });
    } catch (err) {
      app.log.warn({ err, userId: user.id }, "WS post-auth handshake failed; asking client to retry");
      retryAuthAndClose(
        "post_auth_welcome",
        AUTH_RETRYABLE_CODES.HANDSHAKE_INTERNAL_ERROR,
        1011,
        "post-auth handshake failed",
        err instanceof Error ? err.name : "UnknownError",
      );
    }
    return true;
  }

  return { start, rejectInvalidFrame, handle };
}
