import { describe, expect, it, vi } from "vitest";
import {
  assertDaemonStartupAllowedDuringClientSwitch,
  assertSameDeviceMove,
  authorizeDifferentUserLoginSwitch,
  ClientSwitchAuthorizationError,
  ClientSwitchFilesystemError,
  ClientSwitchMaintenanceError,
  ClientSwitchServiceError,
  readClientSwitchMaintenanceState,
  renameSameDeviceDirectory,
  stopServiceForClientSwitch,
} from "../core/client-switch-gates.js";

describe("client switch maintenance gate", () => {
  it("reports lock and journal paths without touching root config/data", () => {
    const home = "/tmp/first-tree";
    const exists = vi.fn((path: string) => path.endsWith("client-switch.lock"));

    expect(readClientSwitchMaintenanceState(home, { exists })).toEqual({
      home,
      stateDir: "/tmp/first-tree/state",
      lockPath: "/tmp/first-tree/state/client-switch.lock",
      journalPath: "/tmp/first-tree/state/client-switch-journal.json",
      parkedClientsDir: "/tmp/first-tree/parked-clients",
      lockExists: true,
      journalExists: false,
      blocked: true,
      reason: "lock",
    });
    expect(exists).toHaveBeenCalledWith("/tmp/first-tree/state/client-switch.lock");
    expect(exists).toHaveBeenCalledWith("/tmp/first-tree/state/client-switch-journal.json");
  });

  it("blocks daemon startup while switch journal recovery is pending", () => {
    expect(() =>
      assertDaemonStartupAllowedDuringClientSwitch("/tmp/first-tree", {
        exists: (path) => path.endsWith("client-switch-journal.json"),
      }),
    ).toThrow(ClientSwitchMaintenanceError);
  });
});

describe("client switch service supervisor gate", () => {
  it("accepts inactive service state after stop", () => {
    const status = {
      platform: "systemd" as const,
      state: "inactive" as const,
      label: "first-tree.service",
      unitPath: "/unit",
      logDir: "/logs",
    };
    expect(
      stopServiceForClientSwitch({
        stop: () => ({ ok: true }),
        status: () => status,
      }),
    ).toBe(status);
  });

  it("aborts when service stop succeeds but supervisor still reports active", () => {
    expect(() =>
      stopServiceForClientSwitch({
        stop: () => ({ ok: true }),
        status: () => ({
          platform: "launchd",
          state: "active",
          label: "dev.first-tree",
          unitPath: "/plist",
          detail: "pid 123",
          logDir: "/logs",
        }),
      }),
    ).toThrow(ClientSwitchServiceError);
  });

  it("aborts when service stop itself fails", () => {
    expect(() =>
      stopServiceForClientSwitch({
        stop: () => ({ ok: false, reason: "permission denied" }),
        status: () => ({
          platform: "systemd",
          state: "inactive",
          label: "first-tree.service",
          unitPath: "/unit",
          logDir: "/logs",
        }),
      }),
    ).toThrow("daemon service stop failed before client switch: permission denied");
  });
});

describe("client switch login authorization", () => {
  it("requires --force-switch for different-user login in non-interactive contexts", () => {
    expect(() => authorizeDifferentUserLoginSwitch({ forceSwitch: false, isInteractive: false })).toThrow(
      ClientSwitchAuthorizationError,
    );
  });

  it("treats --force-switch as interrupt authorization, not a safety-gate bypass", () => {
    expect(authorizeDifferentUserLoginSwitch({ forceSwitch: true, isInteractive: false })).toEqual({
      mode: "force-switch",
      interruptRuntime: true,
      createsNewClientIdForNewUser: true,
      bypassesSafetyGates: false,
    });
  });

  it("allows the interactive path to ask for an explicit switch confirmation", () => {
    expect(authorizeDifferentUserLoginSwitch({ forceSwitch: false, isInteractive: true })).toEqual({
      mode: "interactive-confirmation",
      interruptRuntime: true,
      createsNewClientIdForNewUser: true,
      bypassesSafetyGates: false,
    });
  });
});

describe("client switch filesystem gate", () => {
  const move = { name: "park-root-data", from: "/home/ft/data", to: "/home/ft/parked-clients/client_A/data" };

  it("allows same-device directory rename preflight", () => {
    expect(() =>
      assertSameDeviceMove(move, {
        stat: (path) => ({ dev: path === "/home/ft/data" ? 7 : 7 }),
      }),
    ).not.toThrow();
  });

  it("rejects cross-device moves before rename", () => {
    expect(() =>
      assertSameDeviceMove(move, {
        stat: (path) => ({ dev: path === "/home/ft/data" ? 7 : 8 }),
      }),
    ).toThrow(ClientSwitchFilesystemError);
  });

  it("does not convert EXDEV into an implicit copy fallback", () => {
    const rename = vi.fn(() => {
      throw Object.assign(new Error("cross-device link"), { code: "EXDEV" });
    });

    expect(() =>
      renameSameDeviceDirectory(move, {
        stat: () => ({ dev: 7 }),
        rename,
      }),
    ).toThrow("crossed devices during rename; refusing implicit copy");
    expect(rename).toHaveBeenCalledWith(move.from, move.to);
  });
});
