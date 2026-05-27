import {
  type AttentionCancelledFrame,
  type AttentionOpenedFrame,
  attentionCancelledFrameSchema,
  attentionOpenedFrameSchema,
} from "@first-tree/shared";
import { createLogger, type pino } from "../../observability/logger.js";

/**
 * NHA (Need-Human-Attention) WS-frame demux for the client runtime.
 *
 * The server pushes two Attention frames over the per-client WebSocket:
 *
 *   - `attention:opened`     → target human's connections (web UI / CLI watch)
 *   - `attention:cancelled`  → target human's connections (clear "needs you")
 *
 * There is intentionally no `attention:responded` frame. When the human
 * responds, `respondAttention` posts a chat-echo message that is `@`-mention
 * routed to the asking agent via the standard sendMessage / inbox path, so
 * the origin agent's wake-up rides the existing `chat:message` notify
 * channel. A dedicated responded frame would duplicate that signal and add
 * a separate hand-off into the SessionManager just to land in the same
 * place.
 *
 * This module is intentionally thin: it parses each opened/cancelled
 * frame, logs it, and exposes typed callbacks so consumers (web admin
 * client, CLI `attention list --watch`) can subscribe without threading
 * another argument through the connection layer.
 */

export type AttentionFrameCallbacks = {
  onOpened?: (frame: AttentionOpenedFrame) => void;
  onCancelled?: (frame: AttentionCancelledFrame) => void;
};

export type AttentionFrameDispatcher = {
  /** Feed a raw WS frame; returns true iff the frame was an Attention frame. */
  handle: (raw: Record<string, unknown>) => boolean;
};

const ATTENTION_FRAME_TYPES = new Set(["attention:opened", "attention:cancelled"]);

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
