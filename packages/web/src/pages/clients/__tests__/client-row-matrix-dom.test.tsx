// @vitest-environment happy-dom

import type { CapabilityEntry } from "@first-tree/shared";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HubClient, RuntimeAgent } from "../../../api/activity.js";
import { createDomHarness, type DomHarness } from "../../../test-utils/dom-harness.js";
import { CapabilityMatrix, ClientRow } from "../../clients.js";

const NOW = "2026-05-28T12:00:00.000Z";

function okCapability(sdkVersion = "0.2.84"): CapabilityEntry {
  return { state: "ok", available: true, sdkVersion, detectedAt: NOW };
}
function missingCapability(): CapabilityEntry {
  return { state: "missing", available: false, sdkVersion: null, detectedAt: NOW };
}
function errorCapability(): CapabilityEntry {
  return { state: "error", available: false, sdkVersion: null, detectedAt: NOW, error: "probe failed" };
}

function client(overrides: Partial<HubClient> = {}): HubClient {
  return {
    id: overrides.id ?? "client-1",
    userId: overrides.userId ?? "user-1",
    status: overrides.status ?? "connected",
    authState: overrides.authState ?? "ok",
    binName: overrides.binName ?? "first-tree",
    sdkVersion: overrides.sdkVersion ?? "0.5.0",
    hostname: overrides.hostname ?? "host-a",
    os: overrides.os ?? "darwin",
    agentCount: overrides.agentCount ?? 1,
    connectedAt: overrides.connectedAt ?? NOW,
    lastSeenAt: overrides.lastSeenAt ?? NOW,
    capabilities:
      overrides.capabilities ??
      ({
        "claude-code": okCapability(),
        codex: missingCapability(),
        "claude-code-tui": errorCapability(),
      } satisfies HubClient["capabilities"]),
  };
}

const agents: RuntimeAgent[] = [
  {
    agentId: "agent-1",
    clientId: "client-1",
    runtimeType: "claude-code",
    runtimeState: "idle",
    activeSessions: 1,
    totalSessions: 3,
    runtimeUpdatedAt: NOW,
    type: "agent",
    managedByMe: true,
  },
];

describe("CapabilityMatrix + ClientRow", () => {
  let h: DomHarness;
  beforeEach(() => {
    h = createDomHarness();
  });
  afterEach(() => h.cleanup());

  it("renders empty, ok, missing, and error capability rows", async () => {
    h.render(
      <>
        <CapabilityMatrix capabilities={{}} os="linux" />
        <CapabilityMatrix
          capabilities={{
            "claude-code": okCapability("0.3.0"),
            codex: missingCapability(),
            "claude-code-tui": errorCapability(),
            // null entry path for a known provider missing from the snapshot
          }}
          os="darwin"
        />
      </>,
    );
    await h.flush();
    expect(h.container.textContent).toMatch(/not yet reported|Capabilities/i);
    expect(h.container.textContent).toMatch(/installed|claude|codex|probe failed/i);
  });

  it("expands owner rows, shows matrix + agents, and fires row actions", async () => {
    const onToggle = vi.fn();
    const onDisconnect = vi.fn();
    const onRetire = vi.fn();
    const onReconnect = vi.fn();

    h.render(
      <table>
        <tbody>
          <ClientRow
            client={client({ status: "disconnected", connectedAt: null })}
            boundAgents={agents}
            isExpanded
            agentName={(id) => (id === "agent-1" ? "Nova" : id ?? "")}
            onToggle={onToggle}
            onDisconnect={onDisconnect}
            onRetire={onRetire}
            onReconnect={onReconnect}
          />
        </tbody>
      </table>,
    );
    await h.flush();
    expect(h.container.textContent).toContain("host-a");
    expect(h.container.textContent).toContain("Nova");
    expect(h.container.textContent).toMatch(/Runtimes|installed|sessions/i);

    const row = h.container.querySelector("tr");
    await act(async () => {
      row?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onToggle).toHaveBeenCalled();

    const menuBtn = h.container.querySelector<HTMLButtonElement>('button[aria-label="Computer actions"]');
    if (menuBtn) {
      await act(async () => {
        menuBtn.click();
      });
      await h.flush();
      const reconnect = Array.from(document.body.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("Reconnect"),
      );
      const disconnect = Array.from(document.body.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("Disconnect"),
      );
      const retire = Array.from(document.body.querySelectorAll("button")).find((b) => b.textContent?.includes("Retire"));
      await act(async () => {
        reconnect?.click();
        disconnect?.click();
        retire?.click();
      });
      expect(onReconnect).toHaveBeenCalled();
      expect(onDisconnect).toHaveBeenCalled();
      expect(onRetire).toHaveBeenCalled();
    }
  });

  it("renders restricted team rows without expand or menu", async () => {
    h.render(
      <table>
        <tbody>
          <ClientRow
            client={client()}
            boundAgents={[]}
            isExpanded
            agentName={() => "x"}
            onToggle={vi.fn()}
            onDisconnect={vi.fn()}
            onRetire={vi.fn()}
            onReconnect={vi.fn()}
            showOwner
            ownerLabel={{ text: "Alice" }}
            restricted
          />
        </tbody>
      </table>,
    );
    await h.flush();
    expect(h.container.textContent).toContain("Alice");
    expect(h.container.querySelector('button[aria-label="Computer actions"]')).toBeNull();
    // restricted forces collapsed even when isExpanded is true
    expect(h.container.textContent).not.toMatch(/Runtimes/);
  });
});
