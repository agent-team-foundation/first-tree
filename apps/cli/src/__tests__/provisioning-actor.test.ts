import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { provisioningActorHeaders } from "../core/provisioning-actor.js";

const keys = ["FIRST_TREE_AGENT_ID", "FIRST_TREE_RUNTIME_SESSION_TOKEN_FILE", "FIRST_TREE_CHAT_ID"] as const;
const original = new Map(keys.map((key) => [key, process.env[key]]));
let tempDir: string | undefined;

afterEach(() => {
  for (const key of keys) {
    const value = original.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe("provisioning actor headers", () => {
  it("returns no actor proof outside an agent session", () => {
    for (const key of keys) delete process.env[key];
    expect(provisioningActorHeaders()).toEqual({});
  });

  it("reads the runtime proof and audit context from the session environment", () => {
    tempDir = mkdtempSync(join(tmpdir(), "first-tree-provisioning-"));
    const tokenFile = join(tempDir, "runtime-token");
    writeFileSync(tokenFile, "runtime-proof\n");
    process.env.FIRST_TREE_AGENT_ID = "agent-actor";
    process.env.FIRST_TREE_RUNTIME_SESSION_TOKEN_FILE = tokenFile;
    process.env.FIRST_TREE_CHAT_ID = "chat-1";

    expect(provisioningActorHeaders()).toEqual({
      "x-first-tree-acting-agent": "agent-actor",
      "x-agent-runtime-session": "runtime-proof",
      "x-first-tree-chat-id": "chat-1",
    });
  });

  it("keeps the runtime proof when the optional actor id is absent", () => {
    tempDir = mkdtempSync(join(tmpdir(), "first-tree-provisioning-"));
    const tokenFile = join(tempDir, "runtime-token");
    writeFileSync(tokenFile, "runtime-proof\n");
    process.env.FIRST_TREE_AGENT_ID = "";
    process.env.FIRST_TREE_RUNTIME_SESSION_TOKEN_FILE = tokenFile;
    process.env.FIRST_TREE_CHAT_ID = "";

    expect(provisioningActorHeaders()).toEqual({
      "x-agent-runtime-session": "runtime-proof",
    });
  });
});
