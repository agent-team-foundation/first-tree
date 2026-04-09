import { beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  bindAgentToClient,
  forceDisconnectClient,
  getAgentClientId,
  getClientAgentIds,
  hasClientConnection,
  removeClientConnection,
  setClientConnection,
  unbindAgentFromClient,
} from "../services/connection-manager.js";

/**
 * Unit tests for connection-manager.ts — pure in-memory state management.
 *
 * Focus: the bindAgentToClient fix that removes agent from old client,
 * plus general map consistency between agentToClient and clientConnections.
 */

/** Create a minimal mock WebSocket (only readyState matters here). */
function mockWs(readyState = WebSocket.OPEN): WebSocket {
  return { readyState, close: () => {} } as unknown as WebSocket;
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
    bindAgentToClient(clientA, agent1);

    expect(getAgentClientId(agent1)).toBe(clientA);
    expect(getClientAgentIds(clientA)).toContain(agent1);
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
    bindAgentToClient(clientA, agent1);
    bindAgentToClient(clientA, agent1);

    expect(getAgentClientId(agent1)).toBe(clientA);
    expect(getClientAgentIds(clientA)).toEqual([agent1]);
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
  });
});
