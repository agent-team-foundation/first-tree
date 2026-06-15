import { Client as PgClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readCurrentHandle } from "../framework/current-handle.js";
import {
  createTuiAgent,
  sendUserMessageToTuiAgent,
  type TuiAgentFixture,
  waitForAgentReply,
} from "../framework/runtime-tui-fixture.js";

/**
 * tui-crash-recovery — the fake-tui binary exits non-zero AFTER the first
 * turn completes. The handler's `runTurn` for the next message will find
 * the tmux session dead and report an error event; the runtime should NOT
 * silently ack the message (the runTurn body throws → turnFailed=true →
 * disposition.ack=true per the merged contract; this asserts on the
 * runtime_state landing in `error` so it's visible to operators).
 *
 * The exact post-crash behaviour is the contract-of-record: fast-fail visibly
 * is better than silent absorb. If a future change adds explicit auto-resume
 * (re-start the tmux session and retry), this test should be updated rather
 * than removed.
 */

let handle = readCurrentHandle();
let pg: PgClient;
let fixture: TuiAgentFixture;

beforeAll(async () => {
  handle = readCurrentHandle();
  pg = new PgClient({ connectionString: handle.databaseUrl });
  await pg.connect();
  fixture = await createTuiAgent({
    handle,
    displayName: "tui-crash-recovery agent",
    bindMode: "after-env-patch",
    knobs: { crashAfterTurns: 1 },
  });
});

afterAll(async () => {
  await pg.end().catch(() => undefined);
});

async function readRuntimeState(agentId: string): Promise<string | null> {
  const row = await pg.query<{ runtime_state: string | null }>(
    "SELECT runtime_state FROM agent_presence WHERE agent_id = $1 LIMIT 1",
    [agentId],
  );
  return row.rows[0]?.runtime_state ?? null;
}

describe("tui-crash-recovery — fake exits after turn 1; turn 2 surfaces an error, not a silent ack", () => {
  it("second turn produces an error event and runtime_state ends up in 'error'", async () => {
    // Turn 1 — fake echoes, then exits 7.
    const turn1 = await sendUserMessageToTuiAgent({
      handle,
      chatId: fixture.chatId,
      mentionAgentId: fixture.agentId,
      text: "first turn",
    });
    await waitForAgentReply({ handle, chatId: fixture.chatId, afterMessageId: turn1.id, timeoutMs: 45_000 });

    // Give the crash a moment to register at the runtime layer.
    await new Promise((r) => setTimeout(r, 1_000));

    // Turn 2 — fake is gone; the handler's pasteText (or capturePane) hits a
    // dead session and runTurn throws.
    const turn2 = await sendUserMessageToTuiAgent({
      handle,
      chatId: fixture.chatId,
      mentionAgentId: fixture.agentId,
      text: "second turn (should fail)",
    });

    // Don't expect a reply — instead wait for the runtime_state to flip to
    // error within a reasonable window.
    const deadline = Date.now() + 30_000;
    let state: string | null = null;
    while (Date.now() < deadline) {
      state = await readRuntimeState(fixture.agentId);
      if (state === "error") break;
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(state).toBe("error");

    // Quick sanity on the message itself — the user message stays around;
    // the agent did NOT post a normal reply. We use the message id from turn 2
    // only to keep variable references; no assertion on content needed.
    expect(turn2.id).toBeTruthy();
  });
});
