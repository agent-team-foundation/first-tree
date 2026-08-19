import type { SessionEvent } from "@deepseek-ai/dsh-session";
import { describe, expect, it } from "vitest";
import { classifyDeepseekRunFailure, mapDeepseekSessionEvent, sessionEventFromNotification } from "../events.js";

describe("DeepSeek session events", () => {
  it("reads session.event notifications (dot method name)", () => {
    expect(
      sessionEventFromNotification({
        method: "session.event",
        params: {
          sessionId: "s1",
          event: {
            type: "assistant/chunk",
            seq: 1,
            data: {
              turn: 1,
              step: 1,
              chunk: { type: "text-delta", index: 0, text: "hi" },
            },
          },
        },
      } as never),
    ).toMatchObject({ type: "assistant/chunk" });
    expect(
      sessionEventFromNotification({
        method: "session/event",
        params: { sessionId: "s1", event: { type: "turn/end", seq: 1, data: {} } },
      } as never),
    ).toBeNull();
  });

  it("maps assistant text deltas for chat streaming", () => {
    expect(
      mapDeepseekSessionEvent({
        type: "assistant/chunk",
        seq: 1,
        time: 0,
        data: {
          turn: 1,
          step: 1,
          chunk: { type: "text-delta", index: 0, text: "hello" },
        },
      } as SessionEvent),
    ).toMatchObject({ kind: "text_delta", text: "hello" });
  });

  it("classifies credential failures from error turn ends and empty responses", () => {
    const events = [
      {
        type: "turn/end" as const,
        seq: 2,
        time: 0,
        data: {
          turn: 1,
          reason: {
            kind: "error" as const,
            error: { code: "MISSING_CREDENTIAL", message: "set DEEPSEEK_API_KEY" },
          },
        },
      },
    ] as SessionEvent[];
    expect(
      classifyDeepseekRunFailure({
        finalResponse: "",
        events,
        aborted: false,
      }),
    ).toBe("set DEEPSEEK_API_KEY");
  });
});
