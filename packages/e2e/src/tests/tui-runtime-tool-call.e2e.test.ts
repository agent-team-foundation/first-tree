import { Client as PgClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type CurrentRunHandle, readCurrentHandle } from "../framework/current-handle.js";
import {
  createTuiAgent,
  sendUserMessageToTuiAgent,
  type TuiAgentFixture,
  waitForAgentReply,
} from "../framework/runtime-tui-fixture.js";

/**
 * tui-runtime-tool-call — verify a tool_use + tool_result block in the
 * transcript flows through the shared `createToolCallProcessor` and lands as
 * tool_call events on the chat side (the same plumbing the SDK handler uses).
 *
 * The fake binary's `FAKE_TUI_TOOL_CALL=1` knob emits a `Bash` tool_use, a
 * matching tool_result, then a normal text reply — so we should see both the
 * tool_call session event AND the final assistant text in the chat log.
 *
 * Why this matters separately from tui-runtime-basic: tools are how an agent
 * does anything useful; if the TUI handler emits a tool_use that the runtime
 * silently drops, the agent appears broken from the user's POV. The basic
 * scenario only covers `assistant_text` — this one covers `tool_call`.
 */

let handle: CurrentRunHandle;
let fixture: TuiAgentFixture;
let pg: PgClient;

beforeAll(async () => {
  handle = readCurrentHandle();
  pg = new PgClient({ connectionString: handle.databaseUrl });
  await pg.connect();
  fixture = await createTuiAgent({
    handle,
    displayName: "tui-runtime-tool-call agent",
    knobs: { emitToolCall: true },
  });
});

afterAll(async () => {
  await pg.end().catch(() => undefined);
});

describe("tui-runtime-tool-call — Bash tool_use + tool_result flow through to the chat", () => {
  it("forwards the trailing assistant text AND records the tool_call in messages metadata", async () => {
    const sent = await sendUserMessageToTuiAgent({
      handle,
      chatId: fixture.chatId,
      mentionAgentId: fixture.agentId,
      text: "run bash for me",
    });

    // The text reply still lands as a forwarded chat message — we use that
    // arrival as the ack signal that the turn completed.
    const replies = await waitForAgentReply({
      handle,
      chatId: fixture.chatId,
      afterMessageId: sent.id,
      timeoutMs: 45_000,
    });
    const replyText = replies.map((m) => m.content).join("\n");
    expect(replyText).toContain("run bash for me");

    // Tool calls are recorded server-side in the `session_events` table
    // (kind='tool_call'), NOT as chat messages — the shared
    // `createToolCallProcessor` the TUI handler reuses emits a `tool_call`
    // session event with the tool name + input in its payload. Poll for it.
    const deadline = Date.now() + 10_000;
    let toolEvents: Array<{ kind: string; payload: unknown }> = [];
    while (Date.now() < deadline) {
      const rows = await pg.query<{ kind: string; payload: unknown }>(
        "SELECT kind, payload FROM session_events WHERE chat_id = $1 AND kind = 'tool_call' ORDER BY seq",
        [fixture.chatId],
      );
      if (rows.rows.length > 0) {
        toolEvents = rows.rows;
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    // At least one tool_call event, naming the Bash tool the fake emitted.
    expect(toolEvents.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(toolEvents);
    expect(/bash/i.test(serialized)).toBe(true);
  });
});
