import type postgres from "postgres";
import type { Mock } from "vitest";
import { describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { createNotifier, type Notifier, notifyRecipients } from "../services/notifier.js";

type ListenHandler = (payload?: string) => void;

function createListenClient() {
  const handlers = new Map<string, ListenHandler>();
  const unlisteners: Mock<() => Promise<void>>[] = [];
  const sql = vi.fn(async () => []);
  const listen = vi.fn(async (channel: string, handler: ListenHandler) => {
    handlers.set(channel, handler);
    const unlisten = vi.fn(async () => undefined);
    unlisteners.push(unlisten);
    return { unlisten };
  });
  return {
    handlers,
    listen,
    sql,
    // Test double implements the subset of postgres.Sql used by createNotifier.
    client: Object.assign(sql, { listen }) as unknown as postgres.Sql,
    unlisteners,
  };
}

function socket(open = true, failSend = false): WebSocket {
  const fake = {
    OPEN: 1,
    readyState: open ? 1 : 3,
    send: vi.fn((_frame: string, cb: (err?: Error) => void) => cb(failSend ? new Error("closed") : undefined)),
  };
  // Test double implements only the WebSocket members used by Notifier.
  return fake as unknown as WebSocket;
}

describe("createNotifier", () => {
  it("fans out LISTEN payloads, direct frames, handler errors, and stop cleanup", async () => {
    const { client, handlers, listen, unlisteners } = createListenClient();
    const notifier = createNotifier(client);
    const openSocket = socket(true);
    const failingSocket = socket(true, true);
    const closedSocket = socket(false);
    const pushHandler = vi.fn(async () => undefined);
    const rejectingPushHandler = vi.fn(async () => {
      throw new Error("push failed");
    });
    const configHandler = vi.fn();
    const sessionStateHandler = vi.fn();
    const sessionEventHandler = vi.fn();
    const sessionRuntimeHandler = vi.fn();
    const runtimeHandler = vi.fn();
    const chatMessageHandler = vi.fn();

    notifier.subscribe("inbox-1", openSocket, pushHandler);
    notifier.subscribe("inbox-1", failingSocket, rejectingPushHandler);
    notifier.subscribe("inbox-1", closedSocket, vi.fn());
    notifier.onConfigChange(configHandler);
    notifier.onSessionStateChange(sessionStateHandler);
    notifier.onSessionEvent(() => {
      throw new Error("observer failed");
    });
    notifier.onSessionEvent(sessionEventHandler);
    notifier.onSessionRuntime(() => {
      throw new Error("runtime observer failed");
    });
    notifier.onSessionRuntime(sessionRuntimeHandler);
    notifier.onRuntimeStateChange(runtimeHandler);
    notifier.onChatMessage(() => {
      throw new Error("chat observer failed");
    });
    notifier.onChatMessage(chatMessageHandler);

    await notifier.start();

    expect(listen.mock.calls.map((call) => call[0])).toEqual([
      "inbox_notifications",
      "config_changes",
      "session_state_changes",
      "session_event_changes",
      "session_runtime_changes",
      "runtime_state_changes",
      "chat_message_events",
    ]);

    handlers.get("inbox_notifications")?.("");
    handlers.get("inbox_notifications")?.("malformed");
    handlers.get("inbox_notifications")?.("missing:message-1");
    handlers.get("inbox_notifications")?.("inbox-1:message-2");
    await Promise.resolve();
    expect(pushHandler).toHaveBeenCalledWith("message-2");
    expect(rejectingPushHandler).toHaveBeenCalledWith("message-2");

    handlers.get("config_changes")?.("");
    handlers.get("config_changes")?.("adapter_configs");
    expect(configHandler).toHaveBeenCalledWith("adapter_configs");

    handlers.get("session_state_changes")?.("bad");
    handlers.get("session_state_changes")?.("agent-1:chat-1:active:org-1");
    expect(sessionStateHandler).toHaveBeenCalledWith({
      agentId: "agent-1",
      chatId: "chat-1",
      organizationId: "org-1",
      state: "active",
    });

    handlers.get("session_event_changes")?.("bad");
    handlers.get("session_event_changes")?.("agent-1:chat-1:tool_call:org-1");
    expect(sessionEventHandler).toHaveBeenCalledWith({
      agentId: "agent-1",
      chatId: "chat-1",
      kind: "tool_call",
      organizationId: "org-1",
    });

    handlers.get("session_runtime_changes")?.("bad");
    handlers.get("session_runtime_changes")?.("agent-1:chat-1:working:org-1");
    expect(sessionRuntimeHandler).toHaveBeenCalledWith({
      agentId: "agent-1",
      chatId: "chat-1",
      organizationId: "org-1",
      state: "working",
    });

    handlers.get("runtime_state_changes")?.("bad");
    handlers.get("runtime_state_changes")?.("agent-1:idle:org-1");
    expect(runtimeHandler).toHaveBeenCalledWith({ agentId: "agent-1", organizationId: "org-1", state: "idle" });

    handlers.get("chat_message_events")?.("");
    handlers.get("chat_message_events")?.("bad");
    handlers.get("chat_message_events")?.("chat-1:message-1");
    expect(chatMessageHandler).toHaveBeenCalledWith({ chatId: "chat-1", messageId: "message-1" });

    await expect(notifier.pushFrameToInbox("missing", '{"type":"x"}')).resolves.toBe(0);
    await expect(notifier.pushFrameToInbox("inbox-1", '{"type":"x"}')).resolves.toBe(1);
    expect(openSocket.send).toHaveBeenCalledWith('{"type":"x"}', expect.any(Function));
    expect(failingSocket.send).toHaveBeenCalledWith('{"type":"x"}', expect.any(Function));
    expect(closedSocket.send).not.toHaveBeenCalled();

    notifier.unsubscribe("inbox-1", openSocket);
    notifier.unsubscribe("inbox-1", failingSocket);
    notifier.unsubscribe("inbox-1", closedSocket);
    await expect(notifier.pushFrameToInbox("inbox-1", "{}")).resolves.toBe(0);

    await notifier.stop();
    expect(unlisteners).toHaveLength(7);
    for (const unlisten of unlisteners) expect(unlisten).toHaveBeenCalledTimes(1);

    await notifier.stop();
    for (const unlisten of unlisteners) expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("swallows postgres notify failures and recipient notify rejections", async () => {
    const { client, sql } = createListenClient();
    sql.mockRejectedValue(new Error("pg down"));
    const notifier = createNotifier(client);

    await expect(notifier.notify("inbox-1", "message-1")).resolves.toBeUndefined();
    await expect(notifier.notifyConfigChange("adapter_configs")).resolves.toBeUndefined();
    await expect(notifier.notifySessionStateChange("agent-1", "chat-1", "active", "org-1")).resolves.toBeUndefined();
    await expect(notifier.notifySessionEvent("agent-1", "chat-1", "tool_call", "org-1")).resolves.toBeUndefined();
    await expect(notifier.notifyRuntimeStateChange("agent-1", "idle", "org-1")).resolves.toBeUndefined();
    await expect(notifier.notifySessionRuntime("agent-1", "chat-1", "working", "org-1")).resolves.toBeUndefined();
    await expect(notifier.notifyChatMessage("chat-1", "message-1")).resolves.toBeUndefined();

    const recipientNotifier = {
      notify: vi.fn(async () => {
        throw new Error("notify failed");
      }),
    };
    notifyRecipients(recipientNotifier as unknown as Notifier, ["inbox-a", "inbox-b"], "message-2");
    await Promise.resolve();
    expect(recipientNotifier.notify).toHaveBeenCalledTimes(2);
  });
});
