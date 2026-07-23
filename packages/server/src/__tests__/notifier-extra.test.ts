import { describe, expect, it, vi } from "vitest";
import { createNotifier, notifyRecipients, notifyRecipientsSettled } from "../services/notifier.js";

type ListenHandler = (payload?: string) => void;

type FakeListenClient = {
  calls: unknown[][];
  client: unknown;
  listeners: Map<string, ListenHandler>;
  unlisteners: Array<ReturnType<typeof vi.fn>>;
};

function makeListenClient(shouldRejectNotify = false): FakeListenClient {
  const calls: unknown[][] = [];
  const listeners = new Map<string, ListenHandler>();
  const unlisteners: Array<ReturnType<typeof vi.fn>> = [];
  const client = vi.fn(async (_strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push(values);
    if (shouldRejectNotify) throw new Error("notify failed");
  }) as unknown as {
    listen: (channel: string, handler: ListenHandler) => Promise<{ unlisten: () => Promise<void> }>;
  };
  client.listen = vi.fn(async (channel: string, handler: ListenHandler) => {
    listeners.set(channel, handler);
    const unlisten = vi.fn(async () => undefined);
    unlisteners.push(unlisten);
    return { unlisten };
  });
  return { calls, client, listeners, unlisteners };
}

function makeSocket(sendError?: Error): {
  OPEN: number;
  readyState: number;
  send: ReturnType<typeof vi.fn>;
} {
  return {
    OPEN: 1,
    readyState: 1,
    send: vi.fn((_frame: string, callback?: (err?: Error) => void) => {
      callback?.(sendError);
    }),
  };
}

describe("createNotifier", () => {
  it("fans inbox notifications only to open subscribed sockets and supports direct frame push", async () => {
    const { client, listeners } = makeListenClient();
    const notifier = createNotifier(client as never);
    const openSocket = makeSocket();
    const failingSocket = makeSocket(new Error("backpressure"));
    const closedSocket = { ...makeSocket(), readyState: 3 };
    const pushHandler = vi.fn(async () => undefined);
    const rejectingPushHandler = vi.fn(async () => {
      throw new Error("handler failed");
    });

    notifier.subscribe("inbox_1", openSocket as never, pushHandler);
    notifier.subscribe("inbox_1", failingSocket as never, rejectingPushHandler);
    notifier.subscribe("inbox_1", closedSocket as never, vi.fn());
    await notifier.start();

    listeners.get("inbox_notifications")?.("malformed");
    listeners.get("inbox_notifications")?.("unknown:msg_1");
    listeners.get("inbox_notifications")?.("inbox_1:msg_1");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(pushHandler).toHaveBeenCalledWith("msg_1");
    expect(rejectingPushHandler).toHaveBeenCalledWith("msg_1");
    expect(await notifier.pushFrameToInbox("missing", "{}")).toBe(0);
    expect(await notifier.pushFrameToInbox("inbox_1", '{"type":"ping"}')).toBe(1);
    expect(openSocket.send).toHaveBeenCalledWith('{"type":"ping"}', expect.any(Function));
    expect(failingSocket.send).toHaveBeenCalledWith('{"type":"ping"}', expect.any(Function));

    notifier.unsubscribe("inbox_1", openSocket as never);
    notifier.unsubscribe("inbox_1", failingSocket as never);
    notifier.unsubscribe("inbox_1", closedSocket as never);
    expect(await notifier.pushFrameToInbox("inbox_1", "{}")).toBe(0);
  });

  it("publishes every notification channel and swallows notify failures", async () => {
    const ok = makeListenClient();
    const notifier = createNotifier(ok.client as never);
    const payload = {
      agentId: "agent_1",
      agentType: "codex",
      displayName: "Agent",
      name: null,
      oldClientId: null,
      reason: "switch",
      runtimeProvider: "codex",
      targetClientId: "client_1",
    };

    await notifier.notify("inbox_1", "msg_1");
    await notifier.notifyConfigChange("agent");
    await notifier.notifySessionStateChange("agent_1", "chat_1", "active", "org_1");
    await notifier.notifySessionEvent("agent_1", "chat_1", "tool_call", "org_1");
    await notifier.notifyRuntimeStateChange("agent_1", "working", "org_1");
    await notifier.notifySessionRuntime("agent_1", "chat_1", "working", "org_1");
    await notifier.notifyChatMessage("chat_1", "msg_1");
    await notifier.notifyChatAudience("chat_1");
    await notifier.notifyChatUpdated("chat_1");
    await notifier.notifyAgentRouteChange(payload);
    await notifier.notifyDaemonClientCommand({
      type: "provider-models:list",
      clientId: "client_1",
      provider: "cursor",
      ref: "ref_1",
      targetInstanceId: "instance_1",
    });
    await notifier.notifyDaemonClientCommandResult({ clientId: "client_1", ref: "ref_1" });

    expect(ok.calls).toHaveLength(12);
    expect(ok.calls.map((values) => values[0])).toEqual([
      "inbox_notifications",
      "config_changes",
      "session_state_changes",
      "session_event_changes",
      "runtime_state_changes",
      "session_runtime_changes",
      "chat_message_events",
      "chat_audience_events",
      "chat_updated_events",
      "agent_route_events",
      "daemon_client_commands",
      "daemon_client_command_results",
    ]);

    const failing = createNotifier(makeListenClient(true).client as never);
    await expect(failing.notify("inbox_1", "msg_1")).resolves.toBeUndefined();
    await expect(failing.notifyConfigChange("agent")).resolves.toBeUndefined();
    await expect(failing.notifySessionStateChange("agent_1", "chat_1", "active", "org_1")).resolves.toBeUndefined();
    await expect(failing.notifySessionEvent("agent_1", "chat_1", "tool_call", "org_1")).resolves.toBeUndefined();
    await expect(failing.notifyRuntimeStateChange("agent_1", "working", "org_1")).resolves.toBeUndefined();
    await expect(failing.notifySessionRuntime("agent_1", "chat_1", "working", "org_1")).resolves.toBeUndefined();
    await expect(failing.notifyChatMessage("chat_1", "msg_1")).resolves.toBeUndefined();
    await expect(failing.notifyChatAudience("chat_1")).resolves.toBeUndefined();
    await expect(failing.notifyChatUpdated("chat_1")).resolves.toBeUndefined();
    await expect(failing.notifyAgentRouteChange(payload)).resolves.toBeUndefined();
    await expect(
      failing.notifyDaemonClientCommand({
        type: "provider-models:list",
        clientId: "client_1",
        provider: "cursor",
        ref: "ref_1",
        targetInstanceId: "instance_1",
      }),
    ).resolves.toBeUndefined();
    await expect(
      failing.notifyDaemonClientCommandResult({ clientId: "client_1", ref: "ref_1" }),
    ).resolves.toBeUndefined();
  });

  it("parses LISTEN payloads, ignores malformed data, swallows handler errors, and stops idempotently", async () => {
    const { client, listeners, unlisteners } = makeListenClient();
    const notifier = createNotifier(client as never);
    const config = vi.fn();
    const sessionState = vi.fn();
    const sessionEvent = vi.fn(() => {
      throw new Error("consumer failed");
    });
    const sessionEventSecond = vi.fn();
    const runtimeState = vi.fn();
    const sessionRuntime = vi.fn(() => {
      throw new Error("consumer failed");
    });
    const sessionRuntimeSecond = vi.fn();
    const chatMessage = vi.fn(() => {
      throw new Error("consumer failed");
    });
    const chatAudience = vi.fn(() => {
      throw new Error("consumer failed");
    });
    const chatAudienceSecond = vi.fn();
    const chatUpdated = vi.fn(() => {
      throw new Error("consumer failed");
    });
    const chatUpdatedSecond = vi.fn();
    const meChatsChanged = vi.fn();
    const agentRoute = vi.fn(() => {
      throw new Error("consumer failed");
    });
    const agentRouteSecond = vi.fn();
    const daemonCommand = vi.fn(() => {
      throw new Error("consumer failed");
    });
    const daemonCommandSecond = vi.fn();
    const daemonResult = vi.fn(() => {
      throw new Error("consumer failed");
    });
    const daemonResultSecond = vi.fn();

    notifier.onConfigChange(config);
    notifier.onSessionStateChange(sessionState);
    notifier.onSessionEvent(sessionEvent);
    notifier.onSessionEvent(sessionEventSecond);
    notifier.onRuntimeStateChange(runtimeState);
    notifier.onSessionRuntime(sessionRuntime);
    notifier.onSessionRuntime(sessionRuntimeSecond);
    notifier.onChatMessage(chatMessage);
    notifier.onChatAudience(chatAudience);
    notifier.onChatAudience(chatAudienceSecond);
    notifier.onChatUpdated(chatUpdated);
    notifier.onChatUpdated(chatUpdatedSecond);
    notifier.onMeChatsChanged(meChatsChanged);
    notifier.onAgentRouteChange(agentRoute);
    notifier.onAgentRouteChange(agentRouteSecond);
    notifier.onDaemonClientCommand(daemonCommand);
    notifier.onDaemonClientCommand(daemonCommandSecond);
    notifier.onDaemonClientCommandResult(daemonResult);
    notifier.onDaemonClientCommandResult(daemonResultSecond);
    await notifier.start();

    listeners.get("config_changes")?.("agent");
    listeners.get("config_changes")?.("");
    listeners.get("session_state_changes")?.("agent_1:chat_1:active:org_1");
    listeners.get("session_state_changes")?.("bad");
    listeners.get("session_event_changes")?.("agent_1:chat_1:tool_call:org_1");
    listeners.get("session_runtime_changes")?.("agent_1:chat_1:working:org_1");
    listeners.get("runtime_state_changes")?.("agent_1:idle:org_1");
    listeners.get("runtime_state_changes")?.("bad");
    listeners.get("chat_message_events")?.("chat_1:msg_1");
    listeners.get("chat_message_events")?.("bad");
    listeners.get("chat_audience_events")?.("chat_1");
    listeners.get("chat_updated_events")?.("chat_1");
    listeners.get("me_chats_changed")?.("human_1:org_1");
    listeners.get("me_chats_changed")?.("bad");
    listeners.get("agent_route_events")?.(
      JSON.stringify({
        agentId: "agent_1",
        agentType: "codex",
        displayName: "Agent",
        name: "agent",
        oldClientId: null,
        reason: "switch",
        runtimeProvider: "codex",
        targetClientId: "client_1",
      }),
    );
    listeners.get("agent_route_events")?.("{not json");
    listeners.get("agent_route_events")?.(JSON.stringify({ agentId: "agent_1" }));
    listeners.get("daemon_client_commands")?.(
      JSON.stringify({
        type: "provider-models:list",
        clientId: "client_1",
        provider: "cursor",
        ref: "ref_1",
        targetInstanceId: "instance_1",
      }),
    );
    listeners.get("daemon_client_commands")?.("{not json");
    listeners.get("daemon_client_commands")?.(JSON.stringify({ type: "provider-models:list" }));
    listeners.get("daemon_client_command_results")?.(JSON.stringify({ clientId: "client_1", ref: "ref_1" }));
    listeners.get("daemon_client_command_results")?.("{not json");
    listeners.get("daemon_client_command_results")?.(JSON.stringify({ clientId: "client_1" }));

    expect(config).toHaveBeenCalledWith("agent");
    expect(sessionState).toHaveBeenCalledWith({
      agentId: "agent_1",
      chatId: "chat_1",
      organizationId: "org_1",
      state: "active",
    });
    expect(sessionEventSecond).toHaveBeenCalledWith({
      agentId: "agent_1",
      chatId: "chat_1",
      kind: "tool_call",
      organizationId: "org_1",
    });
    expect(sessionRuntimeSecond).toHaveBeenCalledWith({
      agentId: "agent_1",
      chatId: "chat_1",
      organizationId: "org_1",
      state: "working",
    });
    expect(runtimeState).toHaveBeenCalledWith({ agentId: "agent_1", organizationId: "org_1", state: "idle" });
    expect(chatMessage).toHaveBeenCalledWith({ chatId: "chat_1", messageId: "msg_1" });
    expect(chatAudienceSecond).toHaveBeenCalledWith({ chatId: "chat_1" });
    expect(chatUpdatedSecond).toHaveBeenCalledWith({ chatId: "chat_1" });
    expect(meChatsChanged).toHaveBeenCalledWith({ humanAgentId: "human_1", organizationId: "org_1" });
    // The malformed "bad" payload (no colon) is dropped, not passed through.
    expect(meChatsChanged).toHaveBeenCalledTimes(1);
    expect(agentRouteSecond).toHaveBeenCalledWith({
      agentId: "agent_1",
      agentType: "codex",
      displayName: "Agent",
      name: "agent",
      oldClientId: null,
      reason: "switch",
      runtimeProvider: "codex",
      targetClientId: "client_1",
    });
    expect(daemonCommandSecond).toHaveBeenCalledWith({
      type: "provider-models:list",
      clientId: "client_1",
      provider: "cursor",
      ref: "ref_1",
      targetInstanceId: "instance_1",
    });
    expect(daemonResultSecond).toHaveBeenCalledWith({ clientId: "client_1", ref: "ref_1" });

    await notifier.stop();
    await notifier.stop();
    expect(unlisteners).toHaveLength(13);
    for (const unlisten of unlisteners) {
      expect(unlisten).toHaveBeenCalledTimes(1);
    }
  });

  it("notifies recipient inboxes without awaiting individual failures", async () => {
    const notifier = {
      notify: vi.fn((inboxId: string) => (inboxId === "bad" ? Promise.reject(new Error("boom")) : Promise.resolve())),
      notifyStrict: vi.fn((inboxId: string) =>
        inboxId === "bad" ? Promise.reject(new Error("boom")) : Promise.resolve(),
      ),
    };

    notifyRecipients(notifier as never, ["ok", "bad"], "msg_1");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(notifier.notify).toHaveBeenCalledWith("ok", "msg_1");
    expect(notifier.notify).toHaveBeenCalledWith("bad", "msg_1");
  });

  it("settles recipient notifies and reports failures for observers", async () => {
    const notifier = {
      notify: vi.fn(async () => undefined),
      notifyStrict: vi.fn((inboxId: string) =>
        inboxId === "bad" ? Promise.reject(new Error("boom")) : Promise.resolve(),
      ),
    };

    const result = await notifyRecipientsSettled(notifier as never, ["ok", "bad"], "msg_1");
    expect(result.failed).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(notifier.notifyStrict).toHaveBeenCalledWith("ok", "msg_1");
    expect(notifier.notifyStrict).toHaveBeenCalledWith("bad", "msg_1");
    expect(notifier.notify).not.toHaveBeenCalled();
  });

  it("observes createNotifier pg_notify failures on the settled path only", async () => {
    const rejecting = makeListenClient(true);
    const swallowing = makeListenClient(true);
    const strictNotifier = createNotifier(rejecting.client as never);
    const softNotifier = createNotifier(swallowing.client as never);

    await expect(softNotifier.notify("inbox_1", "msg_soft")).resolves.toBeUndefined();

    const settled = await notifyRecipientsSettled(strictNotifier, ["inbox_1"], "msg_strict");
    expect(settled.failed).toBe(1);
    expect(String(settled.errors[0])).toMatch(/notify failed/);
  });
});
