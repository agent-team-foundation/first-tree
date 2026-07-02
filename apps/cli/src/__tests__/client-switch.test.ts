import { describe, expect, it } from "vitest";
import {
  collectSwitchDrainProcessFromEnvText,
  isSwitchDrainEnvRequired,
  parseSwitchProcessEnvValue,
} from "../core/client-switch.js";

describe("client switch drain markers", () => {
  it("preserves spaces inside NUL-delimited process environment values", () => {
    const envText = [
      "FIRST_TREE_PROVIDER=codex",
      "FIRST_TREE_HOME=/Users/Alice Smith/.first-tree",
      "FIRST_TREE_CLIENT_ID=client_aabbccdd",
      "FIRST_TREE_SWITCH_DRAIN_VERSION=1",
      "",
    ].join("\0");

    expect(parseSwitchProcessEnvValue(envText, "FIRST_TREE_HOME")).toBe("/Users/Alice Smith/.first-tree");
    expect(parseSwitchProcessEnvValue(envText, "FIRST_TREE_CLIENT_ID")).toBe("client_aabbccdd");
  });

  it("keeps whitespace-delimited process text parsing for ps output", () => {
    const envText = "FIRST_TREE_HOME=/Users/alice/.first-tree FIRST_TREE_CLIENT_ID=client_aabbccdd /usr/bin/codex";

    expect(parseSwitchProcessEnvValue(envText, "FIRST_TREE_HOME")).toBe("/Users/alice/.first-tree");
    expect(parseSwitchProcessEnvValue(envText, "FIRST_TREE_CLIENT_ID")).toBe("client_aabbccdd");
  });

  it("preserves spaces inside process text values when another env marker follows", () => {
    const envText =
      "FIRST_TREE_PROVIDER=codex FIRST_TREE_HOME=/Users/Alice Smith/.first-tree FIRST_TREE_CLIENT_ID=client_aabbccdd";

    expect(parseSwitchProcessEnvValue(envText, "FIRST_TREE_HOME")).toBe("/Users/Alice Smith/.first-tree");
    expect(parseSwitchProcessEnvValue(envText, "FIRST_TREE_PROVIDER")).toBe("codex");
  });

  it("treats unknown commands with trusted switch markers as live descendants", () => {
    const providers: Array<{ pid: number; provider: string; command: string }> = [];
    const issues: Array<{ pid: number; command: string; reason: string }> = [];
    const envText = [
      "FIRST_TREE_HOME=/Users/alice/.first-tree",
      "FIRST_TREE_CLIENT_ID=client_aabbccdd",
      "FIRST_TREE_SWITCH_DRAIN_VERSION=1",
      "",
    ].join("\0");

    collectSwitchDrainProcessFromEnvText({
      pid: 123,
      command: "/bin/bash ./provider-child",
      envText,
      home: "/Users/alice/.first-tree",
      clientId: "client_aabbccdd",
      providers,
      issues,
    });

    expect(issues).toEqual([]);
    expect(providers).toEqual([
      expect.objectContaining({ pid: 123, provider: "marked-descendant", command: "/bin/bash ./provider-child" }),
    ]);
  });

  it("fails closed on unknown marked descendants without trusted drain version", () => {
    const providers: Array<{ pid: number; provider: string; command: string }> = [];
    const issues: Array<{ pid: number; command: string; reason: string }> = [];
    const envText = ["FIRST_TREE_HOME=/Users/alice/.first-tree", "FIRST_TREE_CLIENT_ID=client_aabbccdd", ""].join("\0");

    collectSwitchDrainProcessFromEnvText({
      pid: 124,
      command: "node worker.js",
      envText,
      home: "/Users/alice/.first-tree",
      clientId: "client_aabbccdd",
      providers,
      issues,
    });

    expect(providers).toEqual([]);
    expect(issues).toEqual([expect.objectContaining({ pid: 124, reason: "missing trusted switch drain markers" })]);
  });

  it("requires readable env only for known switch-drain process commands", () => {
    expect(isSwitchDrainEnvRequired("/usr/bin/codex exec")).toBe(true);
    expect(isSwitchDrainEnvRequired("node cli/index.mjs daemon start --foreground")).toBe(true);
    expect(isSwitchDrainEnvRequired("/bin/bash unrelated-script")).toBe(false);
  });
});
