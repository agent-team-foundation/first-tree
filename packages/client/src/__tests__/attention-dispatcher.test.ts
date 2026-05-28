import { describe, expect, it, vi } from "vitest";
import type { pino } from "../observability/logger.js";
import { createAttentionFrameDispatcher } from "../runtime/handlers/attention.js";

function testLogger(): pino.Logger {
  const logger = {
    debug: vi.fn(),
    warn: vi.fn(),
  };
  // Test double only needs the methods used by the dispatcher.
  return logger as unknown as pino.Logger;
}

describe("createAttentionFrameDispatcher", () => {
  it("ignores non-attention frames", () => {
    const logger = testLogger();
    const dispatcher = createAttentionFrameDispatcher({}, logger);

    expect(dispatcher.handle({ type: "chat:message" })).toBe(false);
    expect(dispatcher.handle({})).toBe(false);
    expect(logger.debug).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("dispatches valid opened and cancelled frames", () => {
    const logger = testLogger();
    const onOpened = vi.fn();
    const onCancelled = vi.fn();
    const dispatcher = createAttentionFrameDispatcher({ onOpened, onCancelled }, logger);

    expect(
      dispatcher.handle({
        type: "attention:opened",
        attentionId: "attention-1",
        chatId: "chat-1",
        targetHumanId: "human-1",
        requiresResponse: true,
        futureField: "kept by passthrough",
      }),
    ).toBe(true);
    expect(onOpened).toHaveBeenCalledWith(
      expect.objectContaining({
        attentionId: "attention-1",
        chatId: "chat-1",
      }),
    );

    expect(
      dispatcher.handle({
        type: "attention:cancelled",
        attentionId: "attention-1",
        targetHumanId: "human-1",
        reason: null,
      }),
    ).toBe(true);
    expect(onCancelled).toHaveBeenCalledWith(
      expect.objectContaining({
        attentionId: "attention-1",
        targetHumanId: "human-1",
      }),
    );
    expect(logger.debug).toHaveBeenCalledTimes(2);
  });

  it("logs malformed attention frames without calling callbacks", () => {
    const logger = testLogger();
    const onOpened = vi.fn();
    const onCancelled = vi.fn();
    const dispatcher = createAttentionFrameDispatcher({ onOpened, onCancelled }, logger);

    expect(dispatcher.handle({ type: "attention:opened", attentionId: "attention-1" })).toBe(true);
    expect(dispatcher.handle({ type: "attention:cancelled", attentionId: "attention-1" })).toBe(true);

    expect(onOpened).not.toHaveBeenCalled();
    expect(onCancelled).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it("does not require callbacks", () => {
    const logger = testLogger();
    const dispatcher = createAttentionFrameDispatcher({}, logger);

    expect(
      dispatcher.handle({
        type: "attention:opened",
        attentionId: "attention-1",
        chatId: "chat-1",
        targetHumanId: "human-1",
        requiresResponse: false,
      }),
    ).toBe(true);
  });
});
