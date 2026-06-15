import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readCurrentHandle } from "../framework/current-handle.js";
import {
  createTuiAgent,
  sendUserMessageToTuiAgent,
  type TuiAgentFixture,
  waitForAgentReply,
} from "../framework/runtime-tui-fixture.js";

/**
 * tui-runtime-basic — single-turn happy path:
 *   1. User sends a text message.
 *   2. The daemon spawns the fake-tui inside tmux, drives the turn.
 *   3. The fake echoes the input as assistant text.
 *   4. forwardResult posts the assistant text back to chat.
 *
 * Covers the "session start → pasteText → drainEntries → forwardResult → ack"
 * loop without crash or tool-call detours. If this scenario fails, none of
 * the others matter — they layer on top of the same loop.
 */

let fixture: TuiAgentFixture;

beforeAll(async () => {
  const handle = readCurrentHandle();
  fixture = await createTuiAgent({
    handle,
    displayName: "tui-runtime-basic agent",
    bindMode: "after-env-patch",
  });
});

afterAll(async () => {
  // Best-effort cleanup of the per-agent log path is fine; the world
  // teardown wipes `.e2e-runs/`.
});

describe("tui-runtime-basic — single happy turn end-to-end", () => {
  it("user → fake-tui → assistant text → forwarded back to chat", async () => {
    const handle = readCurrentHandle();
    const sent = await sendUserMessageToTuiAgent({
      handle,
      chatId: fixture.chatId,
      mentionAgentId: fixture.agentId,
      text: "ping?",
    });

    const replies = await waitForAgentReply({
      handle,
      chatId: fixture.chatId,
      afterMessageId: sent.id,
      timeoutMs: 45_000,
    });
    expect(replies.length).toBeGreaterThan(0);
    // Fake echoes "<reply prefix>: <userText>" — assert on the user text
    // appearing in the reply so future cosmetic tweaks to the prefix don't
    // tip this over.
    const joined = replies.map((m) => m.content).join("\n");
    expect(joined).toContain("ping?");

    // The fake-tui side-channel log records the turn end + reply text. Asserting
    // here verifies BOTH sides of the contract (forwarded message ↔ fake's
    // own perception of what it answered).
    const turnEndEvents = await fixture.fakeLog.waitUntil((events) => events.some((e) => e.kind === "turn:end"), {
      timeoutMs: 5_000,
      label: "fake-tui turn:end",
    });
    const turnEnd = turnEndEvents.find((e) => e.kind === "turn:end");
    expect(turnEnd?.replyText).toContain("ping?");
  });
});
