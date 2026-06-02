import { Client as PgClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CurrentRunHandle } from "../framework/current-handle.js";
import { respawnActiveClient, stopActiveClient } from "../framework/lifecycle.js";
import {
  createTuiAgent,
  sendUserMessageToTuiAgent,
  type TuiAgentFixture,
  waitForAgentReply,
} from "../framework/runtime-tui-fixture.js";
import { setupOwnTuiWorld, teardownOwnTuiWorld } from "../framework/tui-world.js";

/**
 * tui-restart-resume — the at-least-once contract: a user message sent while
 * a turn is hanging gets REDELIVERED after a daemon restart, not silently
 * absorbed. This is the post-PR #712 contract: a timed-out / interrupted
 * turn leaves the inbox entry un-acked so the message survives a restart
 * (see resolveTurnDisposition + the corresponding handler review).
 *
 * The fake's `FAKE_TUI_HANG=1` knob makes the first turn never reach
 * `forwardResult`; we kill the daemon mid-flight, drop the hang knob, and
 * respawn — the redelivered message should now produce a real reply.
 *
 * Owns its world (`setupOwnTuiWorld`) for the same reason as tui-orphan-sweep:
 * the restart helpers operate on the in-process `activeWorld`, and the
 * destructive restart must not perturb the shared globalSetup world.
 */

let handle: CurrentRunHandle;
let pg: PgClient;
let hangFixture: TuiAgentFixture;

beforeAll(async () => {
  handle = await setupOwnTuiWorld();
  pg = new PgClient({ connectionString: handle.databaseUrl });
  await pg.connect();
  hangFixture = await createTuiAgent({
    handle,
    displayName: "tui-restart-resume hanging agent",
    knobs: { hang: true },
  });
}, 120_000);

afterAll(async () => {
  await pg.end().catch(() => undefined);
  await teardownOwnTuiWorld();
});

describe("tui-restart-resume — message survives a daemon restart and is redelivered", () => {
  // Options object goes in the SECOND argument slot (Vitest 3+). Passing it as
  // the third arg is deprecated and removed in Vitest 4.
  it("hung first daemon timed out → no ack → second daemon (with healthy knobs) replays the message", {
    timeout: 180_000,
  }, async () => {
    const sent = await sendUserMessageToTuiAgent({
      handle,
      chatId: hangFixture.chatId,
      mentionAgentId: hangFixture.agentId,
      text: "redeliver me please",
    });
    expect(sent.id).toBeTruthy();

    // Wait long enough for the handler to be deep into the turn (after
    // tmux paste). Don't wait for the full TURN_TIMEOUT_MS (10m) — restart
    // the daemon early to simulate a real-world "human kills the daemon
    // mid-flight" scenario.
    await new Promise((r) => setTimeout(r, 6_000));

    // Restart the daemon, swapping the agent's hang knob OFF so the
    // redelivered turn can complete. Server-side state survives: the inbox
    // entry stays in-flight (un-acked), the chat/agent rows are intact.
    await stopActiveClient();

    // PATCH the agent's runtime env to drop the hang knob before respawn.
    await pg.query(
      // The runtime config is stored in agent_configs; the simplest local
      // toggle is to delete the FAKE_TUI_HANG env entry from the payload.
      // We use a JSONB removal so the rest of the env (FAKE_TUI_LOG_PATH)
      // stays intact.
      `UPDATE agent_configs
           SET payload = jsonb_set(
             payload,
             '{env}',
             COALESCE((
               SELECT jsonb_agg(e)
                 FROM jsonb_array_elements(payload->'env') AS e
                WHERE e->>'key' <> 'FAKE_TUI_HANG'
             ), '[]'::jsonb)
           )
         WHERE agent_id = $1`,
      [hangFixture.agentId],
    );

    await respawnActiveClient();

    // The redelivered turn should now succeed. Poll for the reply.
    const replies = await waitForAgentReply({
      handle,
      chatId: hangFixture.chatId,
      afterMessageId: sent.id,
      timeoutMs: 90_000,
    });
    expect(replies.length).toBeGreaterThan(0);
    const joined = replies.map((m) => m.content).join("\n");
    expect(joined).toContain("redeliver me please");
  });
});
