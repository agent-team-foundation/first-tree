import { beforeAll, describe, expect, it } from "vitest";
import { readCurrentHandle } from "../framework/current-handle.js";
import {
  createTuiAgent,
  sendUserMessageToTuiAgent,
  type TuiAgentFixture,
  waitForAgentReply,
} from "../framework/runtime-tui-fixture.js";

/**
 * tui-askuser-degrade — when the TUI emits the `Enter to select` menu the
 * handler can't actually navigate (no human at the pane). The handler is
 * supposed to:
 *   1. Send a single `Escape` to dismiss the menu.
 *   2. Pull the cancelled `AskUserQuestion` tool_use from the transcript.
 *   3. Format `input.questions` as plain markdown.
 *   4. forwardResult the formatted text — the next user reply is then
 *      injected as a normal turn.
 *
 * The fake binary's `FAKE_TUI_EMIT_ASKUSER=1` knob exercises exactly this
 * path: first turn writes the AskUser tool_use to the transcript + paints
 * the menu footer; subsequent turns are normal echoes.
 */

let fixture: TuiAgentFixture;

beforeAll(async () => {
  const handle = readCurrentHandle();
  fixture = await createTuiAgent({
    handle,
    displayName: "tui-askuser-degrade agent",
    knobs: { emitAskUser: true },
  });
});

describe("tui-askuser-degrade — Escape cancels the menu and the question lands as plain text", () => {
  it("forwarded reply is the formatted question, NOT the raw tool_use", async () => {
    const handle = readCurrentHandle();
    const sent = await sendUserMessageToTuiAgent({
      handle,
      chatId: fixture.chatId,
      mentionAgentId: fixture.agentId,
      text: "anything — first turn triggers askuser",
    });

    const replies = await waitForAgentReply({
      handle,
      chatId: fixture.chatId,
      afterMessageId: sent.id,
      timeoutMs: 45_000,
    });
    const joined = replies.map((m) => m.content).join("\n");
    // ask-user-degrader.ts renders the questions block with a recognisable
    // opening line — assert on that so cosmetic edits to the rest of the
    // template don't break the test.
    expect(joined).toContain("Claude has a question for you:");
    expect(joined).toContain("Which option do you want?");
    // Options must show through as markdown bullets so the human can answer.
    expect(joined).toContain("Option A");
    expect(joined).toContain("Option B");

    // The fake-tui side-channel proves the handler actually issued the Escape
    // (not the fake giving up on its own).
    const events = await fixture.fakeLog.waitUntil((es) => es.some((e) => e.kind === "askuser:cancelled"), {
      timeoutMs: 5_000,
      label: "askuser:cancelled",
    });
    expect(events.some((e) => e.kind === "askuser:opened")).toBe(true);
    expect(events.some((e) => e.kind === "askuser:cancelled")).toBe(true);
  });
});
