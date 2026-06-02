import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type CurrentRunHandle, readCredentialsOrThrow } from "../framework/current-handle.js";
import { respawnActiveClient, stopActiveClient } from "../framework/lifecycle.js";
import {
  createTuiAgent,
  expectedTuiSessionPrefix,
  sendUserMessageToTuiAgent,
  type TuiAgentFixture,
  waitForAgentReply,
} from "../framework/runtime-tui-fixture.js";
import { hasSession, killSession, listSessionsByPrefix, plantSession } from "../framework/tmux-driver.js";
import { setupOwnTuiWorld, teardownOwnTuiWorld } from "../framework/tui-world.js";

/**
 * tui-orphan-sweep — verify the client-scoped orphan sweep behaviour the
 * reliability gate was added for (PR #712 review round 2):
 *
 *   - Sessions with the EXACT `ftth-<clientTag>-` prefix the daemon owns get
 *     killed on the first handler instantiation in the process.
 *   - Sessions under a DIFFERENT client tag are left alone — the sweep must
 *     never tear down another client's live pane.
 *
 * This test owns its world (`setupOwnTuiWorld`) rather than sharing the
 * globalSetup daemon: it stops + respawns the daemon, and the lifecycle
 * helpers operate on the module-level `activeWorld` which only exists in the
 * process that called `startRunWorld`. Booting in-worker makes the restart
 * helpers reachable AND keeps the destructive restart away from the shared
 * world the other scenarios use.
 */

let handle: CurrentRunHandle;
let fixture: TuiAgentFixture;
let ownedOrphanName: string;
let foreignSessionName: string;

beforeAll(async () => {
  handle = await setupOwnTuiWorld();
  const creds = readCredentialsOrThrow(handle);
  fixture = await createTuiAgent({ handle, displayName: "tui-orphan-sweep agent" });

  // Plant two stale sessions:
  //   - one with the daemon's own prefix (should be swept)
  //   - one with a fictitious different prefix (must survive)
  const ownedPrefix = expectedTuiSessionPrefix(creds.clientId);
  ownedOrphanName = `${ownedPrefix}stale12345678`;
  foreignSessionName = "ftth-other000-stale12345678";

  // Use a real cwd for the planted sessions; the test cwd would be fine but
  // a fresh tmp dir avoids any incidental coupling.
  const cwd = mkdtempSync(join(tmpdir(), "tui-orphan-sweep-"));

  // Bring the daemon down first so it doesn't sweep what we're about to plant.
  await stopActiveClient();
  await plantSession({ name: ownedOrphanName, cwd });
  await plantSession({ name: foreignSessionName, cwd });
  expect(await hasSession(ownedOrphanName)).toBe(true);
  expect(await hasSession(foreignSessionName)).toBe(true);

  // Re-spawn the daemon. The fixture's agent is already created server-side
  // and stays bound; the new daemon process will rebind it on the WS handshake.
  await respawnActiveClient();
}, 120_000);

afterAll(async () => {
  // Best-effort: drop the foreign session we planted, then tear down the world.
  await killSession(foreignSessionName).catch(() => undefined);
  await teardownOwnTuiWorld();
});

describe("tui-orphan-sweep — re-spawn daemon kills owned orphans, leaves foreign sessions", () => {
  it("driving a turn triggers the sweep; owned ftth-<tag>-* die, foreign survives", async () => {
    const sent = await sendUserMessageToTuiAgent({
      handle,
      chatId: fixture.chatId,
      mentionAgentId: fixture.agentId,
      text: "wake the daemon up",
    });

    // Driving a turn forces the handler to instantiate, which is when the
    // module-level orphanSweep fires (before it creates its own session).
    await waitForAgentReply({ handle, chatId: fixture.chatId, afterMessageId: sent.id, timeoutMs: 60_000 });

    // The owned orphan should now be gone; the foreign one untouched.
    expect(await hasSession(ownedOrphanName)).toBe(false);
    expect(await hasSession(foreignSessionName)).toBe(true);

    // The new live session for our agent exists under the owned prefix, but
    // neither the swept orphan nor the foreign session should be in that list.
    const creds = readCredentialsOrThrow(handle);
    const ownedNow = await listSessionsByPrefix(expectedTuiSessionPrefix(creds.clientId));
    expect(ownedNow).not.toContain(ownedOrphanName);
    expect(ownedNow).not.toContain(foreignSessionName);
  });
});
