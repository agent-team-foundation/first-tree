import type { AgentRuntimeConfig } from "@first-tree/shared";
import { describe, expect, it } from "vitest";
import { createConfigDraft } from "../use-config-draft.js";

const config: AgentRuntimeConfig = {
  agentId: "agent-1",
  version: 2,
  updatedAt: "2026-01-01T00:00:00.000Z",
  updatedBy: "member-1",
  payload: {
    kind: "claude-code",
    prompt: { append: "Be precise." },
    model: "sonnet",
    mcpServers: [{ name: "demo", transport: "stdio", command: "echo", args: ["ok"] }],
    env: [{ key: "FOO", value: "bar", sensitive: false }],
    gitRepos: [{ url: "https://github.com/acme/repo.git", localPath: "repo" }],
  },
};

describe("createConfigDraft", () => {
  it("creates a clean draft baseline from a server config", () => {
    const draft = createConfigDraft(config);

    expect(draft.promptAppend).toBe("Be precise.");
    expect(draft.model).toBe("sonnet");
    expect(draft.mcp).toEqual([
      {
        key: "mcp-1",
        value: { name: "demo", transport: "stdio", command: "echo", args: ["ok"] },
        baseline: { name: "demo", transport: "stdio", command: "echo", args: ["ok"] },
        status: "unchanged",
      },
    ]);
    expect(draft.env[0]?.status).toBe("unchanged");
    expect(draft.git[0]?.status).toBe("unchanged");
  });
});
