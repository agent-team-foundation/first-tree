import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyPiChildEnvControls,
  buildPiRpcArgs,
  PI_FORCED_CHILD_ENV,
  PiRpcClient,
  PiRpcProtocolError,
  PiRpcTransportError,
  piV1NativeToolsArg,
  splitPiJsonlBuffer,
} from "../handlers/pi/rpc-client.js";
import type { ProviderProcessSupervisor } from "../runtime/provider-process-supervisor.js";

const LINE_SEP = "\u2028";
const PARA_SEP = "\u2029";

const RPC_CHILD_SCRIPT = `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const mode = process.env.FT_PI_TEST_MODE ?? "happy";

function write(obj) {
  process.stdout.write(JSON.stringify(obj) + "\\n");
}

rl.on("line", (line) => {
  let req;
  try { req = JSON.parse(line); } catch { return; }
  const id = req.id;
  const command = req.type;
  if (command === "get_state") {
    write({ type: "response", id, command: "get_state", success: true, data: { sessionId: "sess-1" } });
    return;
  }
  if (command === "prompt") {
    if (mode === "no_prompt_response") {
      return;
    }
    if (mode === "command_mismatch") {
      write({ type: "response", id, command: "get_state", success: true, data: {} });
      return;
    }
    if (mode === "secret_command_mismatch") {
      write({
        type: "response",
        id,
        command: "PRIVATE_USER_PROMPT_IN_COMMAND please ignore",
        success: true,
        data: {},
      });
      return;
    }
    if (mode === "secret_unmatched_id") {
      write({ type: "response", id, command: "prompt", success: true });
      write({
        type: "response",
        id: "PRIVATE_USER_PROMPT_IN_ID please ignore",
        command: "prompt",
        success: true,
      });
      write({ type: "agent_settled" });
      return;
    }
    write({ type: "response", id, command: "prompt", success: true });
    if (mode === "bad_frame") {
      process.stdout.write("not-json\\n");
      return;
    }
    if (mode === "settlement_hang") {
      return;
    }
    if (mode === "secret_frame") {
      process.stdout.write("not-json SUPER_SECRET_USER_PROMPT\\n");
      return;
    }
    write({
      type: "message_update",
      message: { role: "assistant", content: [] },
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hello" },
    });
    write({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "hello" }],
        provider: "openai-codex",
        model: "gpt-test",
        usage: { input: 3, output: 2, cacheRead: 1, cacheWrite: 0 },
        stopReason: "stop",
      },
    });
    if (mode === "agent_end_only") {
      write({ type: "agent_end", messages: [], willRetry: false });
      return;
    }
    if (mode === "abort_settled_first") {
      write({ type: "agent_settled" });
      return;
    }
    write({ type: "agent_settled" });
    return;
  }
  if (command === "steer") {
    write({ type: "response", id, command: "steer", success: true });
    return;
  }
  if (command === "abort") {
    if (mode === "abort_settled_first") {
      setTimeout(() => write({ type: "response", id, command: "abort", success: true }), 20);
      return;
    }
    write({ type: "response", id, command: "abort", success: true });
    write({ type: "agent_settled" });
    return;
  }
  write({ type: "response", id, command: command ?? "unknown", success: false, error: "unknown command" });
});
`;

function supervisor(): ProviderProcessSupervisor {
  return {
    spawn(spec) {
      const child = spawn(process.execPath, ["-e", RPC_CHILD_SCRIPT], {
        ...spec.options,
        env: {
          ...spec.options.env,
          FT_PI_TEST_MODE: process.env.FT_PI_TEST_MODE ?? "happy",
        },
        detached: false,
      });
      return {
        child,
        exited: new Promise<void>((resolve) => child.on("close", () => resolve())),
      };
    },
  };
}

afterEach(() => {
  delete process.env.FT_PI_TEST_MODE;
});

describe("splitPiJsonlBuffer", () => {
  it("splits on LF only and preserves U+2028/U+2029 inside JSON strings", () => {
    const payload = { type: "event", text: `a${LINE_SEP}b${PARA_SEP}c` };
    const buffer = `${JSON.stringify(payload)}\nrest`;
    const { frames, rest } = splitPiJsonlBuffer(buffer);
    expect(frames).toHaveLength(1);
    expect(JSON.parse(frames[0]!)).toEqual(payload);
    expect(rest).toBe("rest");
  });

  it("strips trailing CR before LF", () => {
    const { frames } = splitPiJsonlBuffer('{"type":"response","id":"1","command":"get_state","success":true}\r\n');
    expect(frames).toEqual(['{"type":"response","id":"1","command":"get_state","success":true}']);
  });
});

describe("buildPiRpcArgs", () => {
  it("builds the rpc session contract with the V1 native tools allowlist (no --offline)", () => {
    const args = buildPiRpcArgs({
      sessionId: "abc",
      sessionDir: "/tmp/sessions",
      skillsDir: "/tmp/skills",
      model: "gpt-test",
    });
    expect(args).toEqual([
      "--mode",
      "rpc",
      "--no-extensions",
      "--no-skills",
      "--skill",
      "/tmp/skills",
      "--no-prompt-templates",
      "--no-approve",
      "--tools",
      "read,bash,edit,write,grep,find,ls",
      "--session-id",
      "abc",
      "--session-dir",
      "/tmp/sessions",
      "--model",
      "gpt-test",
    ]);
    expect(args).not.toContain("--offline");
    expect(args.filter((part) => part === "--tools")).toHaveLength(1);
    expect(args[args.indexOf("--tools") + 1]).toBe(piV1NativeToolsArg());
    // Privacy: argv carries only path/session selectors — never user prompt text.
    expect(args.some((part) => part.includes("user said") || part.includes("SECRET"))).toBe(false);
  });
});

describe("applyPiChildEnvControls", () => {
  it("forces version-check skip and telemetry off after payload merge", () => {
    const env = applyPiChildEnvControls({
      PATH: "/usr/bin",
      PI_SKIP_VERSION_CHECK: "0",
      PI_TELEMETRY: "1",
      CUSTOM: "keep",
    });
    expect(env).toMatchObject({
      PATH: "/usr/bin",
      CUSTOM: "keep",
      PI_SKIP_VERSION_CHECK: PI_FORCED_CHILD_ENV.PI_SKIP_VERSION_CHECK,
      PI_TELEMETRY: PI_FORCED_CHILD_ENV.PI_TELEMETRY,
    });
    expect(env).not.toHaveProperty("PI_OFFLINE");
  });

  it("preserves an operator-provided PI_OFFLINE without injecting one by default", () => {
    expect(applyPiChildEnvControls({ PI_OFFLINE: "1" }).PI_OFFLINE).toBe("1");
    expect(applyPiChildEnvControls({}).PI_OFFLINE).toBeUndefined();
  });
});

describe("PiRpcClient", () => {
  it("sends command objects and correlates echoed command", async () => {
    const events: Record<string, unknown>[] = [];
    const client = await PiRpcClient.start({
      binary: process.execPath,
      args: ["--mode", "rpc"],
      cwd: process.cwd(),
      env: process.env as Record<string, string>,
      supervisor: supervisor(),
      onEvent: (event) => events.push(event),
    });
    const state = await client.getState();
    expect(state).toMatchObject({ command: "get_state", success: true });
    const prompt = await client.prompt("hi");
    expect(prompt).toMatchObject({ command: "prompt", success: true });
    await client.waitForSettled();
    expect(events.some((event) => event.type === "message_update")).toBe(true);
    expect(events.some((event) => event.type === "agent_settled")).toBe(true);
    await client.close();
  });

  it("waits for agent_settled rather than agent_end", async () => {
    process.env.FT_PI_TEST_MODE = "agent_end_only";
    const client = await PiRpcClient.start({
      binary: process.execPath,
      args: ["--mode", "rpc"],
      cwd: process.cwd(),
      env: process.env as Record<string, string>,
      supervisor: supervisor(),
      settlementTimeoutMs: 80,
    });
    await client.prompt("hi");
    await expect(client.waitForSettled()).rejects.toBeInstanceOf(PiRpcTransportError);
    await client.close();
  });

  it("rejects waitForSettled when agent_settled never arrives", async () => {
    process.env.FT_PI_TEST_MODE = "settlement_hang";
    const client = await PiRpcClient.start({
      binary: process.execPath,
      args: ["--mode", "rpc"],
      cwd: process.cwd(),
      env: process.env as Record<string, string>,
      supervisor: supervisor(),
      settlementTimeoutMs: 50,
    });
    await client.prompt("hi");
    await expect(client.waitForSettled()).rejects.toThrow(/settlement timed out/);
    await client.close();
  });

  it("fails closed on invalid JSONL frames", async () => {
    process.env.FT_PI_TEST_MODE = "bad_frame";
    const client = await PiRpcClient.start({
      binary: process.execPath,
      args: ["--mode", "rpc"],
      cwd: process.cwd(),
      env: process.env as Record<string, string>,
      supervisor: supervisor(),
      settlementTimeoutMs: 200,
    });
    await client.prompt("hi");
    await expect(client.waitForSettled()).rejects.toBeInstanceOf(PiRpcProtocolError);
    await client.close();
  });

  it("supports abort after agent_settled already arrived", async () => {
    process.env.FT_PI_TEST_MODE = "abort_settled_first";
    const client = await PiRpcClient.start({
      binary: process.execPath,
      args: ["--mode", "rpc"],
      cwd: process.cwd(),
      env: process.env as Record<string, string>,
      supervisor: supervisor(),
    });
    await client.prompt("hi");
    await client.waitForSettled();
    const settledPromise = client.hasSettled ? Promise.resolve() : client.waitForSettled();
    const abortPromise = client.abort();
    const [abort] = await Promise.all([abortPromise, settledPromise]);
    expect(abort.success).toBe(true);
    await client.close();
  });

  it("classifies onCommandWritten failures after writeLine as after_write and fences", async () => {
    process.env.FT_PI_TEST_MODE = "no_prompt_response";
    const client = await PiRpcClient.start({
      binary: process.execPath,
      args: ["--mode", "rpc"],
      cwd: process.cwd(),
      env: process.env as Record<string, string>,
      supervisor: supervisor(),
      onCommandWritten: () => {
        throw new Error("projection boom after prompt write");
      },
    });
    await expect(client.prompt("hi")).rejects.toMatchObject({
      name: "PiRpcTransportError",
      writePhase: "after_write",
      message: expect.stringContaining("projection boom after prompt write"),
    });
    expect(client.getPromptWriteCount()).toBe(1);
    expect(client.isClosed).toBe(true);
    await expect(client.prompt("again")).rejects.toMatchObject({ writePhase: "before_write" });
    await client.close();
  });

  it("marks prompt-response timeout as after_write and fences the client", async () => {
    process.env.FT_PI_TEST_MODE = "no_prompt_response";
    const client = await PiRpcClient.start({
      binary: process.execPath,
      args: ["--mode", "rpc"],
      cwd: process.cwd(),
      env: process.env as Record<string, string>,
      supervisor: supervisor(),
      requestTimeoutMs: 40,
    });
    await expect(client.prompt("hi")).rejects.toMatchObject({
      name: "PiRpcTransportError",
      writePhase: "after_write",
    });
    expect(client.getPromptWriteCount()).toBe(1);
    expect(client.isClosed).toBe(true);
    await expect(client.prompt("again")).rejects.toMatchObject({ writePhase: "before_write" });
    await client.close();
  });

  it("fences the transport on command mismatch", async () => {
    process.env.FT_PI_TEST_MODE = "command_mismatch";
    const client = await PiRpcClient.start({
      binary: process.execPath,
      args: ["--mode", "rpc"],
      cwd: process.cwd(),
      env: process.env as Record<string, string>,
      supervisor: supervisor(),
    });
    await expect(client.prompt("hi")).rejects.toBeInstanceOf(PiRpcProtocolError);
    expect(client.isClosed).toBe(true);
    expect(client.getPromptWriteCount()).toBe(1);
    await client.close();
  });

  it("does not retain secret-bearing echoed command text on mismatch", async () => {
    process.env.FT_PI_TEST_MODE = "secret_command_mismatch";
    const logs: string[] = [];
    const client = await PiRpcClient.start({
      binary: process.execPath,
      args: ["--mode", "rpc"],
      cwd: process.cwd(),
      env: process.env as Record<string, string>,
      supervisor: supervisor(),
      onLog: (message) => logs.push(message),
    });
    const error = await client.prompt("hi").catch((err: unknown) => err);
    expect(error).toBeInstanceOf(PiRpcProtocolError);
    const text = `${error instanceof Error ? error.message : String(error)}\n${logs.join("\n")}`;
    expect(text).not.toContain("PRIVATE_USER_PROMPT");
    expect(text).toMatch(/command mismatch/);
    expect(text).toMatch(/got=unknown/);
    expect(client.isClosed).toBe(true);
    await client.close();
  });

  it("does not retain secret-bearing unmatched response ids in logs", async () => {
    process.env.FT_PI_TEST_MODE = "secret_unmatched_id";
    const logs: string[] = [];
    const client = await PiRpcClient.start({
      binary: process.execPath,
      args: ["--mode", "rpc"],
      cwd: process.cwd(),
      env: process.env as Record<string, string>,
      supervisor: supervisor(),
      onLog: (message) => logs.push(message),
    });
    await client.prompt("hi");
    await client.waitForSettled();
    const joined = logs.join("\n");
    expect(joined).toMatch(/unmatched response/);
    expect(joined).not.toContain("PRIVATE_USER_PROMPT");
    await client.close();
  });

  it("redacts invalid frames instead of logging raw payload content", async () => {
    process.env.FT_PI_TEST_MODE = "secret_frame";
    const logs: string[] = [];
    const client = await PiRpcClient.start({
      binary: process.execPath,
      args: ["--mode", "rpc"],
      cwd: process.cwd(),
      env: process.env as Record<string, string>,
      supervisor: supervisor(),
      settlementTimeoutMs: 200,
      onLog: (message) => logs.push(message),
    });
    await client.prompt("hi");
    await expect(client.waitForSettled()).rejects.toBeInstanceOf(PiRpcProtocolError);
    expect(logs.join("\\n")).not.toContain("SUPER_SECRET_USER_PROMPT");
    await client.close();
  });

  it("counts steer writes exactly once", async () => {
    const client = await PiRpcClient.start({
      binary: process.execPath,
      args: ["--mode", "rpc"],
      cwd: process.cwd(),
      env: process.env as Record<string, string>,
      supervisor: supervisor(),
    });
    await client.steer("nudge");
    expect(client.getSteerWriteCount()).toBe(1);
    await client.close();
  });

  it("does not surface private stderr prose on process exit", async () => {
    process.env.FT_PI_TEST_MODE = "stderr_exit";
    const logs: string[] = [];
    const privateScript = `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", () => {
  process.stderr.write("PRIVATE_PROMPT_IN_STDERR please ignore\\n");
  process.exit(2);
});
`;
    const localSupervisor = {
      spawn(spec: { options: { env?: NodeJS.ProcessEnv } & object }) {
        const child = spawn(process.execPath, ["-e", privateScript], {
          ...spec.options,
          detached: false,
        });
        return {
          child,
          exited: new Promise<void>((resolve) => child.on("close", () => resolve())),
        };
      },
    };
    const client = await PiRpcClient.start({
      binary: process.execPath,
      args: ["--mode", "rpc"],
      cwd: process.cwd(),
      env: process.env as Record<string, string>,
      supervisor: localSupervisor as ProviderProcessSupervisor,
      onLog: (message) => logs.push(message),
    });
    await expect(client.prompt("hi")).rejects.toThrow(/exited/);
    expect(logs.join("\n")).not.toContain("PRIVATE_PROMPT_IN_STDERR");
    await client.close();
  });
});
