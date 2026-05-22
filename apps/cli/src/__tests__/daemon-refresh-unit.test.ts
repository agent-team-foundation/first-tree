import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { registerDaemonCommands } from "../commands/daemon/index.js";

describe("daemon namespace — refresh-unit hidden subcommand", () => {
  it("registers `refresh-unit` under `daemon` and keeps it hidden from --help", () => {
    const root = new Command();
    registerDaemonCommands(root);
    const daemonCmd = root.commands.find((c) => c.name() === "daemon");
    expect(daemonCmd, "daemon namespace should be registered").toBeDefined();
    const refresh = daemonCmd?.commands.find((c) => c.name() === "refresh-unit");
    expect(refresh, "refresh-unit subcommand should exist").toBeDefined();
    // `hidden: true` is the contract documented in commands/daemon/refresh-unit.ts:
    // this is a supervisor-cooperation interface, not a user-facing verb.
    // We assert via `_hidden` (Commander internal flag) because Commander
    // hasn't shipped a public getter for it yet (v14.x); the prefix is
    // intentional and reasonably stable.
    expect(
      (refresh as unknown as { _hidden?: boolean })._hidden,
      "refresh-unit must remain hidden from `daemon --help`",
    ).toBe(true);
  });

  it("keeps the same five public subcommands visible (start / stop / restart / status / doctor)", () => {
    const root = new Command();
    registerDaemonCommands(root);
    const daemonCmd = root.commands.find((c) => c.name() === "daemon");
    const visibleNames = (daemonCmd?.commands ?? [])
      .filter((c) => !(c as unknown as { _hidden?: boolean })._hidden)
      .map((c) => c.name())
      .sort();
    expect(visibleNames).toEqual(["doctor", "restart", "start", "status", "stop"]);
  });
});
