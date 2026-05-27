import {
  type AttentionCancelledFrame,
  type AttentionOpenedFrame,
  type AttentionRespondedFrame,
  attentionCancelledFrameSchema,
  attentionOpenedFrameSchema,
  attentionRespondedFrameSchema,
} from "@first-tree/shared";
import { createLogger, type pino } from "../../observability/logger.js";

/**
 * NHA (Need-Human-Attention) WS-frame demux for the client runtime.
 *
 * The server pushes three Attention frames over the existing per-client
 * WebSocket:
 *
 *   - `attention:opened`     → target human's connections (web UI / CLI watch)
 *   - `attention:responded`  → origin agent's connections (wake the handler)
 *   - `attention:cancelled`  → target human's connections (clear "needs you")
 *
 * This module is intentionally thin for M1 末: it parses the frame, logs it,
 * and exposes typed callbacks so a future consumer (the Claude Code handler's
 * `await first-tree attention wait` plumbing, M2 初) can subscribe without
 * threading another argument through `SessionManager`. The session-manager
 * hand-off is left as a TODO — the first real consumer will add the missing
 * lookup (attentionId → originAgentId → active session), at which point the
 * handler interface gets an `onAttentionResponded` method or equivalent.
 *
 * Kept as a NEW file (no edits to session-manager.ts) so a parallel agent's
 * work on the same large file doesn't merge-conflict here.
 */

export type AttentionFrameCallbacks = {
  onOpened?: (frame: AttentionOpenedFrame) => void;
  onResponded?: (frame: AttentionRespondedFrame) => void;
  onCancelled?: (frame: AttentionCancelledFrame) => void;
};

export type AttentionFrameDispatcher = {
  /** Feed a raw WS frame; returns true iff the frame was an Attention frame. */
  handle: (raw: Record<string, unknown>) => boolean;
};

const ATTENTION_FRAME_TYPES = new Set(["attention:opened", "attention:responded", "attention:cancelled"]);

/**
 * Build a dispatcher that recognises Attention WS frames and routes them to
 * the supplied callbacks after Zod validation. Callers wire the returned
 * `handle` into their existing frame demux (e.g. an extra branch in
 * `ClientConnection.handleMessage`) — the dispatcher itself owns no socket
 * state, which keeps it cheap to construct per agent / per session.
 *
 * The `passthrough()` on the frame schemas means forward-rolling servers can
 * add fields without breaking the client; only malformed frames are dropped
 * with a warn-level log.
 */
export function createAttentionFrameDispatcher(
  callbacks: AttentionFrameCallbacks = {},
  logger: pino.Logger = createLogger("attention"),
): AttentionFrameDispatcher {
  return {
    handle(raw: Record<string, unknown>): boolean {
      const type = typeof raw.type === "string" ? raw.type : null;
      if (type === null || !ATTENTION_FRAME_TYPES.has(type)) return false;

      if (type === "attention:opened") {
        const parsed = attentionOpenedFrameSchema.safeParse(raw);
        if (!parsed.success) {
          logger.warn(
            { issues: parsed.error.issues.map((i) => i.message) },
            "malformed attention:opened frame — dropping",
          );
          return true;
        }
        logger.debug({ attentionId: parsed.data.attentionId, chatId: parsed.data.chatId }, "attention:opened");
        callbacks.onOpened?.(parsed.data);
        return true;
      }

      if (type === "attention:responded") {
        const parsed = attentionRespondedFrameSchema.safeParse(raw);
        if (!parsed.success) {
          logger.warn(
            { issues: parsed.error.issues.map((i) => i.message) },
            "malformed attention:responded frame — dropping",
          );
          return true;
        }
        // TODO(M2): thread this into SessionManager so the origin agent's
        // active session (if any) is woken with the human response. Today
        // the frame carries `originAgentId` but no `chatId`, so resolving
        // the target session requires a `sdk.attention.show(attentionId)`
        // round-trip; the first consumer (Claude Code handler's
        // `attention wait` path) will add that lookup. For now we log + emit
        // via callback so external subscribers can observe the wake signal.
        logger.info(
          {
            attentionId: parsed.data.attentionId,
            originAgentId: parsed.data.originAgentId,
          },
          "attention:responded — no runtime hand-off yet (TODO M2)",
        );
        callbacks.onResponded?.(parsed.data);
        return true;
      }

      // attention:cancelled
      const parsed = attentionCancelledFrameSchema.safeParse(raw);
      if (!parsed.success) {
        logger.warn(
          { issues: parsed.error.issues.map((i) => i.message) },
          "malformed attention:cancelled frame — dropping",
        );
        return true;
      }
      logger.debug(
        {
          attentionId: parsed.data.attentionId,
          targetHumanId: parsed.data.targetHumanId,
        },
        "attention:cancelled",
      );
      callbacks.onCancelled?.(parsed.data);
      return true;
    },
  };
}
