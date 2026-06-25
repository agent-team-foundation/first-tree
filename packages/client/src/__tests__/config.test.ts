import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_AGENT_CONCURRENCY,
  DEFAULT_AGENT_MAX_SESSIONS,
  DEFAULT_WORKING_GRACE_SECONDS,
} from "@first-tree/shared/config";
import { describe, expect, it } from "vitest";
import { loadRuntimeConfig } from "../runtime/config.js";

function writeTempYaml(content: string): string {
  const path = join(tmpdir(), `first-tree-test-${crypto.randomUUID().slice(0, 8)}.yaml`);
  writeFileSync(path, content, "utf-8");
  return path;
}

describe("Runtime Config", () => {
  it("loads a valid config with agentId and type", () => {
    const path = writeTempYaml(`
server: http://localhost:8000
agents:
  nova:
    agentId: agent-nova-uuid
    type: claude-code
`);
    const config = loadRuntimeConfig(path);
    expect(config.server).toBe("http://localhost:8000");

    const nova = config.agents.nova;
    expect(nova).toBeDefined();
    expect(nova?.agentId).toBe("agent-nova-uuid");
    expect(nova?.type).toBe("claude-code");
    // Defaults are kept in lock-step with `@first-tree/shared`
    // `agentConfigSchema` — see runtime/config.ts. The shipped CLI goes
    // through that schema; this YAML loader is the legacy back-door.
    expect(nova?.concurrency).toBe(DEFAULT_AGENT_CONCURRENCY);
    expect(nova?.session.idle_timeout).toBe(300);
    expect(nova?.session.max_sessions).toBe(DEFAULT_AGENT_MAX_SESSIONS);
    expect(nova?.session.working_grace_seconds).toBe(DEFAULT_WORKING_GRACE_SECONDS);
  });

  it("loads config with custom session and concurrency settings", () => {
    const path = writeTempYaml(`
server: http://example.com:9000
agents:
  reviewer:
    agentId: agent-reviewer-uuid
    type: claude-code
    session:
      idle_timeout: 600
      max_sessions: 20
    concurrency: 3
`);
    const config = loadRuntimeConfig(path);
    const reviewer = config.agents.reviewer;
    expect(reviewer).toBeDefined();
    expect(reviewer?.session.idle_timeout).toBe(600);
    expect(reviewer?.session.max_sessions).toBe(20);
    expect(reviewer?.concurrency).toBe(3);
  });

  it("supports multiple agents", () => {
    const path = writeTempYaml(`
agents:
  agent1:
    agentId: uuid-1
    type: claude-code
  agent2:
    agentId: uuid-2
    type: claude-code
`);
    const config = loadRuntimeConfig(path);
    expect(Object.keys(config.agents)).toHaveLength(2);
    expect(config.agents.agent1?.agentId).toBe("uuid-1");
    expect(config.agents.agent2?.agentId).toBe("uuid-2");
  });

  it("expands environment variables in agentId", () => {
    process.env.TEST_CONFIG_AGENT_ID = "env-resolved-agent";
    try {
      const path = writeTempYaml(`
agents:
  myagent:
    agentId: \${TEST_CONFIG_AGENT_ID}
    type: claude-code
`);
      const config = loadRuntimeConfig(path);
      expect(config.agents.myagent?.agentId).toBe("env-resolved-agent");
    } finally {
      delete process.env.TEST_CONFIG_AGENT_ID;
    }
  });

  it("expands environment variables inside arrays", () => {
    process.env.TEST_CONFIG_REPO = "first-tree";
    try {
      const path = writeTempYaml(`
agents:
  myagent:
    agentId: agent-1
    type: claude-code
    repos:
      - \${TEST_CONFIG_REPO}
`);
      const config = loadRuntimeConfig(path);
      const myagent = config.agents.myagent as unknown as { repos?: string[] };
      expect(myagent.repos).toEqual(["first-tree"]);
    } finally {
      delete process.env.TEST_CONFIG_REPO;
    }
  });

  it("throws for missing environment variable", () => {
    delete process.env.NONEXISTENT_VAR_XYZ;
    const path = writeTempYaml(`
agents:
  myagent:
    agentId: \${NONEXISTENT_VAR_XYZ}
    type: claude-code
`);
    expect(() => loadRuntimeConfig(path)).toThrow(/NONEXISTENT_VAR_XYZ/);
  });

  it("throws when no agents are defined", () => {
    const path = writeTempYaml(`
server: http://localhost:8000
agents: {}
`);
    expect(() => loadRuntimeConfig(path)).toThrow();
  });

  it("throws when agentId is missing", () => {
    const path = writeTempYaml(`
agents:
  myagent:
    type: claude-code
`);
    expect(() => loadRuntimeConfig(path)).toThrow();
  });

  it("throws when type is missing", () => {
    const path = writeTempYaml(`
agents:
  myagent:
    agentId: some-uuid
`);
    expect(() => loadRuntimeConfig(path)).toThrow();
  });

  it("uses default server URL when not specified", () => {
    const path = writeTempYaml(`
agents:
  myagent:
    agentId: some-uuid
    type: claude-code
`);
    const config = loadRuntimeConfig(path);
    expect(config.server).toBe("http://localhost:8000");
  });
});
