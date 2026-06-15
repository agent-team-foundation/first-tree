import { beforeAll, describe, expect, it } from "vitest";
import { execCli } from "../framework/cli-driver/exec.js";
import { readCurrentHandle } from "../framework/current-handle.js";
import {
  createTuiAgent,
  sendUserMessageToTuiAgent,
  type TuiAgentFixture,
  waitForAgentReply,
} from "../framework/runtime-tui-fixture.js";

/**
 * tui-runtime-resume — happy path for a suspended TUI session:
 *   1. First turn starts a fresh fake TUI and forwards a reply.
 *   2. Operator suspend tears down the tmux process but preserves the session id.
 *   3. A later message resumes with `--resume <oldId>` and forwards that reply too.
 *
 * Regression coverage for the e2e fake's resume transcript contract: when the
 * handler no longer passes `--session-id` on resume, the fake must still append
 * to the resumed session's transcript file, because that is what the handler
 * tails for user-visible output.
 */

let fixture: TuiAgentFixture;

beforeAll(async () => {
  const handle = readCurrentHandle();
  fixture = await createTuiAgent({ handle, displayName: "tui-runtime-resume agent" });
});

describe("tui-runtime-resume — suspended session resumes and forwards output", () => {
  it("fresh turn forwards, suspend closes tmux, resumed turn also forwards", { timeout: 120_000 }, async () => {
    const handle = readCurrentHandle();

    const firstExpected = "FT_E2E_TUI_RESUME_FIRST";
    const first = await sendUserMessageToTuiAgent({
      handle,
      chatId: fixture.chatId,
      mentionAgentId: fixture.agentId,
      text: `first turn, include ${firstExpected}`,
    });
    const firstReplies = await waitForAgentReply({
      handle,
      chatId: fixture.chatId,
      afterMessageId: first.id,
      predicate: (m) => m.senderId !== handle.credentials?.humanAgentId && m.content.includes(firstExpected),
      timeoutMs: 45_000,
    });
    expect(firstReplies.length).toBeGreaterThan(0);

    const suspend = await execCli({
      home: handle.clientHome,
      serverBaseUrl: handle.serverBaseUrl,
      args: ["agent", "session", "suspend", fixture.agentName, fixture.chatId],
      timeoutMs: 30_000,
    });
    expect(suspend.exitCode).toBe(0);

    await new Promise((r) => setTimeout(r, 1_500));

    const secondExpected = "FT_E2E_TUI_RESUME_SECOND";
    const second = await sendUserMessageToTuiAgent({
      handle,
      chatId: fixture.chatId,
      mentionAgentId: fixture.agentId,
      text: `resume turn, include ${secondExpected}`,
    });
    const secondReplies = await waitForAgentReply({
      handle,
      chatId: fixture.chatId,
      afterMessageId: second.id,
      predicate: (m) => m.senderId !== handle.credentials?.humanAgentId && m.content.includes(secondExpected),
      timeoutMs: 90_000,
    });
    expect(secondReplies.length).toBeGreaterThan(0);

    const events = fixture.fakeLog.readAll();
    const resumeStart = events.find((e) => e.kind === "start" && e.resumeId);
    expect(resumeStart).toBeDefined();
    expect(resumeStart?.sessionId).toBe(resumeStart?.resumeId);
    expect(events.some((e) => e.kind === "turn:end" && String(e.replyText).includes(secondExpected))).toBe(true);
  });
});
