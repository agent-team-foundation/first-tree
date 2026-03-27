import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadRuntimeConfig } from "../runtime/config.js";

function writeTempYaml(content: string): string {
  const path = join(tmpdir(), `first-tree-hub-test-${crypto.randomUUID().slice(0, 8)}.yaml`);
  writeFileSync(path, content, "utf-8");
  return path;
}

describe("Runtime Config", () => {
  it("loads a valid config with type field", () => {
    const path = writeTempYaml(`
server: http://localhost:8000
agents:
  kael:
    token: test-token-123
    type: claude-code
`);
    const config = loadRuntimeConfig(path);
    expect(config.server).toBe("http://localhost:8000");

    const kael = config.agents.kael;
    expect(kael).toBeDefined();
    expect(kael?.token).toBe("test-token-123");
    expect(kael?.type).toBe("claude-code");
    expect(kael?.concurrency).toBe(5); // default
    expect(kael?.session.idle_timeout).toBe(300); // default
    expect(kael?.session.max_sessions).toBe(10); // default
  });

  it("loads config with custom session and concurrency settings", () => {
    const path = writeTempYaml(`
server: http://example.com:9000
agents:
  reviewer:
    token: review-token
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
    token: token1
    type: claude-code
  agent2:
    token: token2
    type: claude-code
`);
    const config = loadRuntimeConfig(path);
    expect(Object.keys(config.agents)).toHaveLength(2);
    expect(config.agents.agent1?.token).toBe("token1");
    expect(config.agents.agent2?.token).toBe("token2");
  });

  it("expands environment variables in token", () => {
    process.env.TEST_CONFIG_TOKEN = "env-resolved-token";
    try {
      const path = writeTempYaml(`
agents:
  myagent:
    token: \${TEST_CONFIG_TOKEN}
    type: claude-code
`);
      const config = loadRuntimeConfig(path);
      expect(config.agents.myagent?.token).toBe("env-resolved-token");
    } finally {
      delete process.env.TEST_CONFIG_TOKEN;
    }
  });

  it("throws for missing environment variable", () => {
    delete process.env.NONEXISTENT_VAR_XYZ;
    const path = writeTempYaml(`
agents:
  myagent:
    token: \${NONEXISTENT_VAR_XYZ}
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

  it("throws when token is missing", () => {
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
    token: some-token
`);
    expect(() => loadRuntimeConfig(path)).toThrow();
  });

  it("uses default server URL when not specified", () => {
    const path = writeTempYaml(`
agents:
  myagent:
    token: tok
    type: claude-code
`);
    const config = loadRuntimeConfig(path);
    expect(config.server).toBe("http://localhost:8000");
  });
});
