import { Client as PgClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execCli } from "../framework/cli-driver/exec.js";
import { type CurrentRunHandle, readCurrentHandle } from "../framework/current-handle.js";
import {
  createTuiAgent,
  sendUserMessageToTuiAgent,
  type TuiAgentFixture,
  waitForAgentReply,
} from "../framework/runtime-tui-fixture.js";

let handle: CurrentRunHandle;
let fixture: TuiAgentFixture;
let pg: PgClient;

beforeAll(async () => {
  handle = readCurrentHandle();
  pg = new PgClient({ connectionString: handle.databaseUrl });
  await pg.connect();
  fixture = await createTuiAgent({
    handle,
    displayName: "tui-runtime-suspend-race agent",
    bindMode: "after-env-patch",
    knobs: { readyDelayMs: 2_500 },
  });
});

afterAll(async () => {
  await pg.end().catch(() => undefined);
});

async function suspendFixtureSession(): Promise<void> {
  const suspend = await execCli({
    home: handle.clientHome,
    serverBaseUrl: handle.serverBaseUrl,
    args: ["agent", "session", "suspend", fixture.agentName, fixture.chatId],
    timeoutMs: 30_000,
  });
  expect(suspend.exitCode).toBe(0);
}

describe("tui-runtime-suspend-race — suspend while resume is preparing", () => {
  it("does not tear down a preparing tmux session and then call runTurn", { timeout: 120_000 }, async () => {
    const firstExpected = "FT_E2E_TUI_SUSPEND_RACE_FIRST";
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
      predicate: (m) => m.content.includes(firstExpected),
      timeoutMs: 60_000,
    });
    expect(firstReplies.length).toBeGreaterThan(0);

    await suspendFixtureSession();

    await sendUserMessageToTuiAgent({
      handle,
      chatId: fixture.chatId,
      mentionAgentId: fixture.agentId,
      text: "resume while a second suspend arrives",
    });

    await fixture.fakeLog.waitUntil((events) => events.some((e) => e.kind === "start" && e.resumeId), {
      timeoutMs: 45_000,
      label: "resume fake started",
    });
    await suspendFixtureSession();

    await new Promise((r) => setTimeout(r, 3_000));

    const rows = await pg.query<{ payload: { message?: string } }>(
      "SELECT payload FROM session_events WHERE chat_id = $1 AND kind = 'error' ORDER BY seq",
      [fixture.chatId],
    );
    const errorText = rows.rows.map((row) => row.payload.message ?? "").join("\n");
    expect(errorText).not.toContain("runTurn called before session was prepared");
    expect(errorText).not.toContain("paste-buffer");
    expect(errorText).not.toContain("resilience.session.retry_scheduled");
  });
});
