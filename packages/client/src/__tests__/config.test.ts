import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadRuntimeConfig } from "../runtime/config.js";
import { CONCURRENCY, IDLE_TIMEOUT_MS, MAX_SESSIONS } from "../runtime/constants.js";

function writeTempYaml(content: string): string {
  const path = join(tmpdir(), `first-tree-hub-test-${crypto.randomUUID().slice(0, 8)}.yaml`);
  writeFileSync(path, content, "utf-8");
  return path;
}

describe("Runtime Config", () => {
  it("loads a valid config with agentId and type", () => {
    const path = writeTempYaml(`
server: http://localhost:8000
agents:
  kael:
    agentId: agent-kael-uuid
    type: claude-code
`);
    const config = loadRuntimeConfig(path);
    expect(config.server).toBe("http://localhost:8000");

    const kael = config.agents.kael;
    expect(kael).toBeDefined();
    expect(kael?.agentId).toBe("agent-kael-uuid");
    expect(kael?.type).toBe("claude-code");
    // Step 11 (PRD §D15): runtime params come from runtime/constants.ts,
    // not from agent.yaml (the legacy fields are still warned about but
    // ignored).
    expect(kael?.concurrency).toBe(CONCURRENCY);
    expect(kael?.session.idle_timeout).toBe(IDLE_TIMEOUT_MS / 1000);
    expect(kael?.session.max_sessions).toBe(MAX_SESSIONS);
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
