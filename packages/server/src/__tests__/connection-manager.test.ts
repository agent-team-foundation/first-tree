import { beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  bindAgentToClient,
  forceDisconnect,
  forceDisconnectClient,
  getAgentClientId,
  getAgentRuntimeSession,
  getClientAgentIds,
  hasClientConnection,
  removeClientConnection,
  setClientConnection,
  unbindAgentFromClient,
  validateAgentRuntimeSession,
} from "../services/connection-manager.js";

/**
 * Unit tests for connection-manager.ts — pure in-memory state management.
 *
 * Focus: the bindAgentToClient fix that removes agent from old client,
 * plus general map consistency between agentToClient and clientConnections.
 */

/** Create a minimal mock WebSocket (only readyState matters here). */
function mockWs(readyState = WebSocket.OPEN): WebSocket {
  return { readyState, close: () => {}, send: () => {} } as unknown as WebSocket;
}

// connection-manager uses module-level Maps, so we need to clean up
// between tests by removing all known entries.
function cleanup(clientIds: string[], agentIds: string[]) {
  for (const aid of agentIds) {
    unbindAgentFromClient(aid);
  }
  for (const cid of clientIds) {
    forceDisconnectClient(cid);
  }
}

describe("connection-manager: bindAgentToClient", () => {
  const clientA = "client-A";
  const clientB = "client-B";
  const agent1 = "agent-1";
  const agent2 = "agent-2";
  const wsA = mockWs();
  const wsB = mockWs();

  beforeEach(() => {
    cleanup([clientA, clientB], [agent1, agent2]);
    setClientConnection(clientA, wsA);
    setClientConnection(clientB, wsB);
  });

  it("binds agent to client and updates both maps", () => {
    const token = bindAgentToClient(clientA, agent1);

    expect(getAgentClientId(agent1)).toBe(clientA);
    expect(getClientAgentIds(clientA)).toContain(agent1);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(getAgentRuntimeSession(agent1)).toEqual({ clientId: clientA, runtimeSessionToken: token });
    expect(validateAgentRuntimeSession(agent1, clientA, token)).toBe(true);
  });

  it("rebind to new client removes agent from old client agentIds", () => {
    bindAgentToClient(clientA, agent1);
    expect(getClientAgentIds(clientA)).toContain(agent1);

    // Rebind agent1 to clientB
    bindAgentToClient(clientB, agent1);

    // agent1 should be in clientB, NOT in clientA
    expect(getAgentClientId(agent1)).toBe(clientB);
    expect(getClientAgentIds(clientB)).toContain(agent1);
    expect(getClientAgentIds(clientA)).not.toContain(agent1);
  });

  it("rebind does not affect other agents on old client", () => {
    bindAgentToClient(clientA, agent1);
    bindAgentToClient(clientA, agent2);
    expect(getClientAgentIds(clientA)).toEqual(expect.arrayContaining([agent1, agent2]));

    // Move only agent1 to clientB
    bindAgentToClient(clientB, agent1);

    // agent2 stays on clientA
    expect(getClientAgentIds(clientA)).toContain(agent2);
    expect(getClientAgentIds(clientA)).not.toContain(agent1);
  });

  it("binding same agent to same client is idempotent", () => {
    const firstToken = bindAgentToClient(clientA, agent1);
    const secondToken = bindAgentToClient(clientA, agent1);

    expect(getAgentClientId(agent1)).toBe(clientA);
    expect(getClientAgentIds(clientA)).toEqual([agent1]);
    expect(secondToken).not.toBe(firstToken);
    expect(validateAgentRuntimeSession(agent1, clientA, firstToken)).toBe(false);
    expect(validateAgentRuntimeSession(agent1, clientA, secondToken)).toBe(true);
  });

  it("does not unbind when expected client does not own the agent", () => {
    bindAgentToClient(clientB, agent1);

    const removed = unbindAgentFromClient(agent1, clientA);

    expect(removed).toBe(false);
    expect(getAgentClientId(agent1)).toBe(clientB);
    expect(getClientAgentIds(clientB)).toContain(agent1);
  });

  it("clears the runtime session token on unbind", () => {
    const token = bindAgentToClient(clientA, agent1);

    const removed = unbindAgentFromClient(agent1, clientA);

    expect(removed).toBe(true);
    expect(getAgentRuntimeSession(agent1)).toBeUndefined();
    expect(validateAgentRuntimeSession(agent1, clientA, token)).toBe(false);
  });
});

describe("connection-manager: removeClientConnection", () => {
  const clientA = "client-rm-A";
  const agent1 = "agent-rm-1";
  const agent2 = "agent-rm-2";

  it("removes all agents bound to the client", () => {
    const ws = mockWs();
    setClientConnection(clientA, ws);
    bindAgentToClient(clientA, agent1);
    bindAgentToClient(clientA, agent2);

    const removed = removeClientConnection(clientA, ws);

    expect(removed.sort()).toEqual([agent1, agent2].sort());
    expect(getAgentClientId(agent1)).toBeUndefined();
    expect(getAgentClientId(agent2)).toBeUndefined();
    expect(getAgentRuntimeSession(agent1)).toBeUndefined();
    expect(getAgentRuntimeSession(agent2)).toBeUndefined();
    expect(hasClientConnection(clientA)).toBe(false);
  });

  it("returns empty array if ws does not match", () => {
    const ws1 = mockWs();
    const ws2 = mockWs();
    setClientConnection(clientA, ws1);
    bindAgentToClient(clientA, agent1);

    const removed = removeClientConnection(clientA, ws2);
    expect(removed).toEqual([]);
    // Original binding should still exist
    expect(getAgentClientId(agent1)).toBe(clientA);
  });
});

describe("connection-manager: forceDisconnectClient", () => {
  it("cleans up all agent bindings", () => {
    const clientA = "client-force-A";
    const agent1 = "agent-force-1";
    const ws = mockWs();
    setClientConnection(clientA, ws);
    bindAgentToClient(clientA, agent1);

    const removed = forceDisconnectClient(clientA);
    expect(removed).toEqual([agent1]);
    expect(getAgentClientId(agent1)).toBeUndefined();
    expect(getAgentRuntimeSession(agent1)).toBeUndefined();
  });
});

describe("connection-manager: setClientConnection takeover protection", () => {
  it("closes existing active connection when new WS registers with same clientId", () => {
    const clientId = "client-takeover";
    const agent1 = "agent-takeover-1";
    let closeCalled = false;
    const ws1 = {
      readyState: WebSocket.OPEN,
      close: () => {
        closeCalled = true;
      },
      send: () => {},
    } as unknown as WebSocket;
    const ws2 = mockWs();

    setClientConnection(clientId, ws1);
    bindAgentToClient(clientId, agent1);

    // New connection with same clientId should close the old one
    setClientConnection(clientId, ws2);

    expect(closeCalled).toBe(true);
    // Old agent bindings should be cleaned up
    expect(getAgentClientId(agent1)).toBeUndefined();
    expect(getAgentRuntimeSession(agent1)).toBeUndefined();

    // Cleanup
    forceDisconnectClient(clientId);
  });

  it("does not close if same WS instance re-registers", () => {
    const clientId = "client-same-ws";
    let closeCalled = false;
    const ws = {
      readyState: WebSocket.OPEN,
      close: () => {
        closeCalled = true;
      },
      send: () => {},
    } as unknown as WebSocket;

    setClientConnection(clientId, ws);
    setClientConnection(clientId, ws);

    expect(closeCalled).toBe(false);

    forceDisconnectClient(clientId);
  });
});

describe("connection-manager: forceDisconnect M1 mode", () => {
  it("unbinds single agent without closing the shared client WS", () => {
    const clientId = "client-m1-force";
    const agent1 = "agent-m1-1";
    const agent2 = "agent-m1-2";
    let closeCalled = false;
    const sentMessages: string[] = [];
    const ws = {
      readyState: WebSocket.OPEN,
      close: () => {
        closeCalled = true;
      },
      send: (data: string) => {
        sentMessages.push(data);
      },
    } as unknown as WebSocket;

    setClientConnection(clientId, ws);
    bindAgentToClient(clientId, agent1);
    bindAgentToClient(clientId, agent2);

    // Force disconnect only agent1
    const result = forceDisconnect(agent1, "agent_suspended");

    expect(result).toBe(true);
    // WS should NOT be closed
    expect(closeCalled).toBe(false);
    // Should have sent force_disconnect message
    expect(sentMessages).toHaveLength(1);
    expect(JSON.parse(sentMessages[0] as string)).toEqual({
      type: "agent:force_disconnect",
      agentId: agent1,
      reason: "agent_suspended",
    });
    // agent1 unbound, agent2 still bound
    expect(getAgentClientId(agent1)).toBeUndefined();
    expect(getAgentClientId(agent2)).toBe(clientId);
    expect(getAgentRuntimeSession(agent1)).toBeUndefined();
    expect(getClientAgentIds(clientId)).toEqual([agent2]);

    // Cleanup
    forceDisconnectClient(clientId);
  });

  it("does not force-disconnect when expected client is stale", () => {
    const currentClientId = "client-m1-current";
    const staleClientId = "client-m1-stale";
    const agent1 = "agent-m1-stale-1";
    const sentMessages: string[] = [];
    const ws = {
      readyState: WebSocket.OPEN,
      close: () => {},
      send: (data: string) => {
        sentMessages.push(data);
      },
    } as unknown as WebSocket;

    setClientConnection(currentClientId, ws);
    bindAgentToClient(currentClientId, agent1);

    const result = forceDisconnect(agent1, "agent_rebound", staleClientId);

    expect(result).toBe(false);
    expect(sentMessages).toHaveLength(0);
    expect(getAgentClientId(agent1)).toBe(currentClientId);

    forceDisconnectClient(currentClientId);
  });
});
