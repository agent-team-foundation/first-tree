import { type Options, query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { FAKE_CLAUDE_CODE_EXECUTABLE } from "../framework/agent-mock.js";

/**
 * Agent-mock spike — proves the fake `claude-code` binary speaks enough of
 * the stream-json protocol for the official `@anthropic-ai/claude-agent-sdk`
 * `query()` to consume it end-to-end. This is the M2 "三档 spike 取首先成功
 * 的固化" milestone: the **fake binary path** wins (vs. ANTHROPIC_BASE_URL
 * env or HTTP_PROXY). See `src/mocks/fake-claude-code.mjs` for the
 * protocol decisions.
 *
 * Why this layer (SDK direct), not full hub round-trip: the hub client
 * runtime needs an agent.yaml on disk + an AgentSlot wired to a real
 * workspace bootstrap (`packages/client/src/runtime/bootstrap.ts`). That
 * surface is M3 — proposal §九 explicitly framed agent runtime e2e as a
 * spike before commitment. This test closes the SDK-level loop so M3 can
 * focus on hub-side glue instead of binary protocol debugging.
 *
 * No globalSetup dependencies — the SDK + fake binary are self-contained.
 */

async function collect(prompt: string, opts?: Partial<Options>): Promise<{ assistantText: string[]; result: string | null }> {
  const inputs: SDKUserMessage[] = [
    {
      type: "user",
      message: { role: "user", content: prompt },
      parent_tool_use_id: null,
      session_id: "fake-session",
    },
  ];
  async function* feed(): AsyncIterable<SDKUserMessage> {
    for (const m of inputs) yield m;
  }

  const handle = query({
    prompt: feed(),
    options: {
      pathToClaudeCodeExecutable: FAKE_CLAUDE_CODE_EXECUTABLE,
      ...opts,
    },
  });

  const assistantText: string[] = [];
  let result: string | null = null;
  let sawSystemInit = false;
  for await (const msg of handle) {
    if (msg.type === "system" && msg.subtype === "init") {
      sawSystemInit = true;
      continue;
    }
    if (msg.type === "assistant") {
      for (const block of msg.message.content) {
        if (block.type === "text") assistantText.push(block.text);
      }
      continue;
    }
    if (msg.type === "result") {
      if (msg.subtype === "success") result = msg.result;
      break;
    }
  }
  if (!sawSystemInit) throw new Error("never saw system:init from fake binary");
  return { assistantText, result };
}

describe("M2 agent-mock spike — fake claude-code binary survives SDK round-trip", () => {
  it("emits one assistant text + a success result for a single user message", async () => {
    const { assistantText, result } = await collect("ping?");
    expect(assistantText.length).toBeGreaterThan(0);
    expect(assistantText.join("\n")).toContain("ping?");
    expect(result).toContain("ping?");
  });

  it("honours FAKE_CLAUDE_REPLY override", async () => {
    const orig = process.env.FAKE_CLAUDE_REPLY;
    process.env.FAKE_CLAUDE_REPLY = "always-this";
    try {
      const { assistantText, result } = await collect("anything");
      expect(assistantText.join("\n")).toBe("always-this");
      expect(result).toBe("always-this");
    } finally {
      if (orig === undefined) delete process.env.FAKE_CLAUDE_REPLY;
      else process.env.FAKE_CLAUDE_REPLY = orig;
    }
  });
});
