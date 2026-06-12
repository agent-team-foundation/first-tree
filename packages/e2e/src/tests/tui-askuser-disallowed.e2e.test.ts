import { beforeAll, describe, expect, it } from "vitest";
import { readCurrentHandle } from "../framework/current-handle.js";
import {
  createTuiAgent,
  sendUserMessageToTuiAgent,
  type TuiAgentFixture,
  waitForAgentReply,
} from "../framework/runtime-tui-fixture.js";

/**
 * tui-askuser-disallowed — AskUserQuestion is not supported in First Tree:
 * there is no human at the tmux pane to drive the selection menu. The handler
 * prevents the situation instead of degrading out of it — it launches claude
 * with `--disallowed-tools AskUserQuestion`, stripping the tool from the
 * model's context so the menu can never surface. (`--dangerously-skip-
 * permissions` bypasses the permission layer, so a permissions-based deny is
 * not an option; the old Escape-cancel + markdown degrade path was removed
 * end-to-end in PR #747.)
 *
 * The fake binary records its full argv in the `start` side-channel event,
 * so the assertion is on the exact flag pair the real claude would receive.
 */

let fixture: TuiAgentFixture;

beforeAll(async () => {
  const handle = readCurrentHandle();
  fixture = await createTuiAgent({
    handle,
    displayName: "tui-askuser-disallowed agent",
  });
});

describe("tui-askuser-disallowed — claude is launched with the tool disabled", () => {
  it("spawn argv contains --disallowed-tools AskUserQuestion as an adjacent pair", async () => {
    const handle = readCurrentHandle();
    const sent = await sendUserMessageToTuiAgent({
      handle,
      chatId: fixture.chatId,
      mentionAgentId: fixture.agentId,
      text: "anything — any turn proves the spawn happened",
    });

    // A completed turn guarantees the fake binary started and logged its
    // `start` event; asserting after the reply avoids racing the spawn.
    await waitForAgentReply({
      handle,
      chatId: fixture.chatId,
      afterMessageId: sent.id,
      timeoutMs: 45_000,
    });

    const startEvent = fixture.fakeLog.first("start");
    expect(startEvent).not.toBeNull();
    const argv = startEvent?.argv;
    if (!Array.isArray(argv)) {
      throw new Error(`fake-tui start event carries no argv array: ${JSON.stringify(startEvent)}`);
    }
    const args = argv.map(String);
    const flagIdx = args.indexOf("--disallowed-tools");
    expect(flagIdx).toBeGreaterThan(-1);
    expect(args[flagIdx + 1]).toBe("AskUserQuestion");
  });
});
