import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type CurrentRunHandle, readCredentialsOrThrow } from "../framework/current-handle.js";
import {
  createTuiAgent,
  expectedTuiSessionName,
  expectedTuiSessionPrefix,
  sendUserMessageToTuiAgent,
  type TuiAgentFixture,
  waitForAgentReply,
} from "../framework/runtime-tui-fixture.js";
import { listBuffers, listSessionsByPrefix } from "../framework/tmux-driver.js";
import { setupOwnTuiWorld, teardownOwnTuiWorld } from "../framework/tui-world.js";

/**
 * tui-tmux-lifecycle — verify the session ownership + buffer hygiene
 * contract:
 *
 *   1. On first turn, the handler creates a tmux session whose name matches
 *      `deriveSessionName(clientId, agentId, chatId)` exactly.
 *   2. After the turn completes, tmux is left holding no leftover
 *      `<sessionName>-msg` paste buffer (the handler's `paste-buffer -d` +
 *      `delete-buffer` backstop must fire).
 *   3. The session prefix matches `ftth-<clientTag>-` — important for both
 *      orphan-sweep behaviour and for not stomping on other clients.
 *
 * Owns its world: the exact-session-name assertion needs a deterministic
 * 1-agent daemon. In the shared globalSetup world, leftover ftth-* sessions
 * from the other steady-state agents (TUI sessions persist until shutdown)
 * plus message-dispatch ordering make a by-name `has-session` poll racy. A
 * dedicated world removes that noise — exactly the reason orphan-sweep and
 * restart-resume own theirs.
 */

let handle: CurrentRunHandle;
let fixture: TuiAgentFixture;

beforeAll(async () => {
  handle = await setupOwnTuiWorld();
  fixture = await createTuiAgent({
    handle,
    displayName: "tui-tmux-lifecycle agent",
    bindMode: "after-env-patch",
  });
}, 120_000);

afterAll(async () => {
  await teardownOwnTuiWorld();
});

describe("tui-tmux-lifecycle — session naming + buffer hygiene", () => {
  it("creates exactly one client-scoped session and leaves no paste buffer behind", async () => {
    const creds = readCredentialsOrThrow(handle);
    const ownedPrefix = expectedTuiSessionPrefix(creds.clientId);

    const sent = await sendUserMessageToTuiAgent({
      handle,
      chatId: fixture.chatId,
      mentionAgentId: fixture.agentId,
      text: "hello tmux",
    });

    // Wait for the reply first: its arrival proves the handler spun up a live
    // tmux session, drove the turn, and forwarded the result. This is the
    // reliable readiness signal (it's exactly what tui-runtime-basic asserts);
    // polling tmux by an independently-derived name races the handler's
    // bootstrap and is sensitive to digest-input assumptions.
    await waitForAgentReply({ handle, chatId: fixture.chatId, afterMessageId: sent.id, timeoutMs: 60_000 });

    // The session is named under the client-scoped prefix `ftth-<clientTag>-`.
    // This own-world has exactly one agent + one chat, so exactly one owned
    // session should exist — proving client-scoped naming without depending on
    // reproducing the internal SHA-256 digest of (agentId, chatId).
    const ownedSessions = await listSessionsByPrefix(ownedPrefix);
    expect(ownedSessions.length).toBe(1);
    const sessionName = ownedSessions[0];
    expect(sessionName?.startsWith(ownedPrefix)).toBe(true);
    // The digest segment is a 12-hex SHA-256 slice (collision-resistant names,
    // not a truncated uuid prefix — the PR #712 review contract).
    expect(sessionName?.slice(ownedPrefix.length)).toMatch(/^[0-9a-f]{12}$/);
    // Strong check: the session name matches the handler's deriveSessionName
    // exactly (SHA-256 of `${agentId}\0${chatId}`, NUL-separated). This also
    // guards the `expectedTuiSessionName` helper against separator drift.
    expect(sessionName).toBe(
      expectedTuiSessionName({ clientTagSource: creds.clientId, agentId: fixture.agentId, chatId: fixture.chatId }),
    );

    // Buffer hygiene: after the turn the handler must have deleted the
    // `<sessionName>-msg` paste buffer it used to inject our text (paste-buffer
    // -d + delete-buffer backstop). No owned `*-msg` buffer should linger.
    const buffers = await listBuffers();
    expect(buffers.some((b) => b.startsWith(ownedPrefix) && b.endsWith("-msg"))).toBe(false);
    expect(buffers).not.toContain(`${sessionName}-msg`);
  });
});
