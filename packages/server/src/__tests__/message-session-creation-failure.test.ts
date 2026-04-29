import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { inboxEntries } from "../db/schema/inbox-entries.js";
import { createChat } from "../services/chat.js";
import { createTestAgent, useTestApp } from "./helpers.js";

// Hoist a single mock function so we can drive the failure injection from
// within the test body. `vi.hoisted` runs before any import, including the
// `vi.mock` factory below.
const { mockedUpsert } = vi.hoisted(() => ({ mockedUpsert: vi.fn() }));

vi.mock("../services/activity.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/activity.js")>();
  // Default behavior: forward to the real implementation. Tests opt in to
  // failure with `mockedUpsert.mockRejectedValueOnce(...)`.
  mockedUpsert.mockImplementation(actual.upsertSessionState);
  return { ...actual, upsertSessionState: mockedUpsert };
});

// `services/message.js` may already be cached by the worker (vitest config
// uses `pool: forks` with `isolate: false`), in which case it holds a
// reference to the real `upsertSessionState` and our mock would be ignored.
// Reset the module graph and re-import so the mocked binding wins.
let sendMessage: typeof import("../services/message.js")["sendMessage"];
beforeAll(async () => {
  vi.resetModules();
  const m = await import("../services/message.js");
  sendMessage = m.sendMessage;
});

describe("sendMessage — N4-B: predictive activation failure does not block the message", () => {
  const getApp = useTestApp();

  it("when upsertSessionState rejects, message + inbox row are still durable, and the function returns normally", async () => {
    const app = getApp();
    const { agent: a1 } = await createTestAgent(app, { name: `n4-a-${crypto.randomUUID().slice(0, 6)}` });
    const { agent: a2 } = await createTestAgent(app, { name: `n4-b-${crypto.randomUUID().slice(0, 6)}` });
    const chat = await createChat(app.db, a1.uuid, { type: "direct", participantIds: [a2.uuid] });

    // 1:1 chat fan-out produces exactly one upsertSessionState call.
    mockedUpsert.mockRejectedValueOnce(new Error("simulated upsert failure"));

    const result = await sendMessage(app.db, chat.id, a1.uuid, { format: "text", content: "should still arrive" });

    expect(result.message).toBeDefined();
    expect(result.message.content).toBe("should still arrive");
    expect(result.recipients).toHaveLength(1);
    expect(result.recipients[0]).toBe(a2.inboxId);
    expect(mockedUpsert).toHaveBeenCalled();

    // Inbox row was committed in the main transaction — independent of the
    // predictive activation outcome (N4-B: best-effort, never blocks).
    const [entry] = await app.db
      .select({ inboxId: inboxEntries.inboxId, messageId: inboxEntries.messageId, notify: inboxEntries.notify })
      .from(inboxEntries)
      .where(eq(inboxEntries.messageId, result.message.id))
      .limit(1);
    expect(entry).toBeDefined();
    expect(entry?.notify).toBe(true);
  });
});
