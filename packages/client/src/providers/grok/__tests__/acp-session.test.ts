import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderProcessSupervisor } from "../../../runtime/provider-process-supervisor.js";
import { fetchGrokAcpInitializeMeta, runGrokAcpAttempt } from "../acp-session.js";

/**
 * Transport-level coverage for the model-discovery ACP handshake, against a
 * REAL child process (a node script standing in for the grok binary). Locks
 * the bounded EOF→close barrier: every path — success, non-zero exit, EOF
 * ignored, initialize failure — must reclaim the process, and success
 * requires a clean exit 0.
 */

const FAKE_AGENT_SCRIPT = `
const fs = require("fs");
const behavior = process.env.GROK_FAKE_DISCOVERY_BEHAVIOR || "success";
const pidFile = process.env.GROK_FAKE_DISCOVERY_PID_FILE || "";
if (pidFile) fs.writeFileSync(pidFile, String(process.pid));
let buffer = "";
function send(msg) { process.stdout.write(JSON.stringify(msg) + "\\n"); }
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let idx = buffer.indexOf("\\n");
  while (idx >= 0) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    if (line.trim()) {
      let req = null;
      try { req = JSON.parse(line); } catch {}
      if (req && req.method === "initialize" && req.id !== undefined) {
        if (behavior === "init_error") {
          send({ jsonrpc: "2.0", id: req.id, error: { code: -32000, message: "initialize rejected" } });
        } else {
          send({ jsonrpc: "2.0", id: req.id, result: { protocolVersion: behavior === "wrong_protocol" ? 2 : 1, agentCapabilities: {}, _meta: { agentVersion: "0.2.117", modelState: { currentModelId: "grok-4", availableModels: [{ modelId: "grok-4", name: "Grok 4" }] } } } });
        }
      } else if (req && req.method === "session/new" && req.id !== undefined) {
        send({ jsonrpc: "2.0", id: req.id, result: { sessionId: "s-probe", models: { currentModelId: "grok-4", availableModels: [] } } });
      } else if (req && req.method === "session/set_model" && req.id !== undefined) {
        send({ jsonrpc: "2.0", id: req.id, result: { _meta: { model: { Ok: req.params && req.params.modelId } } } });
      } else if (req && req.method === "session/prompt" && req.id !== undefined) {
        const clientPid = req.params && req.params._meta && typeof req.params._meta.promptId === "string" ? req.params._meta.promptId : "p1";
        send({ jsonrpc: "2.0", id: req.id, result: { stopReason: "end_turn", _meta: { promptId: clientPid, modelId: "grok-4" } } });
      }
    }
    idx = buffer.indexOf("\\n");
  }
});
process.stdin.on("end", () => {
  if (behavior === "ignore_eof" || behavior === "hold_after_prompt") return; // deliberately never exits
  process.exit(behavior === "exit_nonzero" ? 3 : 0);
});
if (behavior === "ignore_eof" || behavior === "hold_after_prompt") setInterval(() => {}, 1000);
`;

let dir: string;
let binary: string;

function pidFileFor(name: string): string {
  return join(dir, `${name}.pid`);
}

function assertProcessGone(pidFile: string): void {
  const pid = Number(readFileSync(pidFile, "utf8"));
  expect(Number.isInteger(pid)).toBe(true);
  let alive = true;
  try {
    process.kill(pid, 0);
  } catch {
    alive = false;
  }
  expect(alive).toBe(false);
}

function fetchMeta(behavior: string, pidFile: string, over: { timeoutMs?: number; eofCloseWaitMs?: number } = {}) {
  return fetchGrokAcpInitializeMeta({
    binary,
    env: {
      ...process.env,
      GROK_FAKE_DISCOVERY_BEHAVIOR: behavior,
      GROK_FAKE_DISCOVERY_PID_FILE: pidFile,
    },
    timeoutMs: over.timeoutMs ?? 5_000,
    eofCloseWaitMs: over.eofCloseWaitMs ?? 300,
    clientVersion: "0",
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "grok-acp-discovery-test-"));
  binary = join(dir, "fake-grok");
  writeFileSync(binary, `#!/usr/bin/env node\n${FAKE_AGENT_SCRIPT}`);
  chmodSync(binary, 0o755);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("fetchGrokAcpInitializeMeta — bounded EOF→close barrier", () => {
  it("returns the initialize _meta on a clean exit 0", async () => {
    const pidFile = pidFileFor("success");
    const result = await fetchMeta("success", pidFile);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.meta).toMatchObject({ agentVersion: "0.2.117" });
    assertProcessGone(pidFile);
  });

  it("fails (no silent success) when the child exits non-zero after initialize", async () => {
    const pidFile = pidFileFor("nonzero");
    const result = await fetchMeta("exit_nonzero", pidFile);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toContain("exited 3");
    assertProcessGone(pidFile);
  });

  it("reclaims a child that ignores stdin EOF and reports failure", async () => {
    const pidFile = pidFileFor("ignore-eof");
    const startedAt = Date.now();
    const result = await fetchMeta("ignore_eof", pidFile, { eofCloseWaitMs: 200 });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toContain("exit 0 required");
    // The bounded barrier must terminate the child well under the overall timeout.
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    assertProcessGone(pidFile);
  });

  it("reclaims the child when initialize fails while the child is still alive", async () => {
    const pidFile = pidFileFor("init-error");
    const result = await fetchMeta("init_error", pidFile);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toContain("initialize rejected");
    assertProcessGone(pidFile);
  });

  it("rejects an initialize response with an incompatible protocolVersion", async () => {
    const pidFile = pidFileFor("wrong-protocol");
    const result = await fetchMeta("wrong_protocol", pidFile);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toContain("protocolVersion 2");
    assertProcessGone(pidFile);
  });

  it("times out and kills a child that never answers initialize", async () => {
    const pidFile = pidFileFor("silent");
    // A binary that reads stdin forever without answering anything.
    const silent = join(dir, "fake-grok-silent");
    writeFileSync(
      silent,
      `#!/usr/bin/env node\nconst fs = require("fs");fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));process.stdin.resume();setInterval(() => {}, 1000);\n`,
    );
    chmodSync(silent, 0o755);
    const result = await fetchGrokAcpInitializeMeta({
      binary: silent,
      env: process.env,
      timeoutMs: 1_000,
      eofCloseWaitMs: 200,
      clientVersion: "0",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toContain("timed out");
    assertProcessGone(pidFile);
  });
});

describe("runGrokAcpAttempt — teardown timer hygiene", () => {
  it("reclaims a child with non-piped stdio and bounded-waits for its close", async () => {
    if (process.platform === "win32") return; // POSIX process-group kill semantics
    let childPid: number | undefined;
    const supervisor: ProviderProcessSupervisor = {
      spawn(spec) {
        // stdio "ignore" yields null stdio streams — the defensive branch.
        const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
          ...spec.options,
          stdio: "ignore",
        });
        childPid = child.pid;
        return { child, exited: new Promise<void>((resolve) => child.once("exit", () => resolve())) };
      },
    };
    const outcome = await runGrokAcpAttempt({
      supervisor,
      binary,
      args: [],
      env: { PATH: process.env.PATH ?? "" },
      cwd: dir,
      abortSignal: new AbortController().signal,
      label: "grok unpiped reclaim test",
      clientVersion: "0",
      resumeSessionId: null,
      mcpServers: [],
      model: "",
      reasoningEffort: "",
      promptText: "hi",
      onSessionUpdate: () => {},
      onXaiNotification: () => {},
      log: () => {},
    });

    expect(outcome.spawnError?.message).toContain("not piped");
    // The child was SIGKILLed and the branch waited for it to die.
    if (!childPid) throw new Error("unreachable");
    let alive = true;
    try {
      process.kill(childPid, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  });

  it("a fast-closing non-piped child resolves well before the reclaim deadline", async () => {
    if (process.platform === "win32") return; // POSIX process-group kill semantics
    const supervisor: ProviderProcessSupervisor = {
      spawn(spec) {
        // Exits ~50ms after spawn with null stdio — the reclaim must catch the
        // close via the pre-registered waiter, not wait the full 5s deadline.
        const child = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 50)"], {
          ...spec.options,
          stdio: "ignore",
        });
        return { child, exited: new Promise<void>((resolve) => child.once("exit", () => resolve())) };
      },
    };
    const startedAt = Date.now();
    const outcome = await runGrokAcpAttempt({
      supervisor,
      binary,
      args: [],
      env: { PATH: process.env.PATH ?? "" },
      cwd: dir,
      abortSignal: new AbortController().signal,
      label: "grok unpiped fast-close test",
      clientVersion: "0",
      resumeSessionId: null,
      mcpServers: [],
      model: "",
      reasoningEffort: "",
      promptText: "hi",
      onSessionUpdate: () => {},
      onXaiNotification: () => {},
      log: () => {},
    });

    expect(outcome.spawnError?.message).toContain("not piped");
    // The 5s reclaim deadline must NOT be hit: a fast close resolves almost immediately.
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it("clears pending SIGKILL timers once the terminated child closes (no post-close group kill)", async () => {
    if (process.platform === "win32") return; // POSIX process-group kill semantics
    const spy = vi.spyOn(process, "kill");
    const supervisor: ProviderProcessSupervisor = {
      spawn(spec) {
        const child = spawn(binary, [], {
          ...spec.options,
          env: { ...spec.options.env, GROK_FAKE_DISCOVERY_BEHAVIOR: "hold_after_prompt" },
        });
        return { child, exited: new Promise<void>((resolve) => child.once("exit", () => resolve())) };
      },
    };
    try {
      const outcome = await runGrokAcpAttempt({
        supervisor,
        binary,
        args: [],
        env: Object.fromEntries(
          Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
        ),
        cwd: dir,
        abortSignal: new AbortController().signal,
        label: "grok timer-hygiene test",
        clientVersion: "0",
        resumeSessionId: null,
        mcpServers: [],
        model: "",
        reasoningEffort: "",
        promptText: "hi",
        eofCloseWaitMs: 50,
        killGraceMs: 50,
        onSessionUpdate: () => {},
        onXaiNotification: () => {},
        log: () => {},
      });

      // The child answered the prompt, ignored EOF, and was reclaimed via
      // SIGTERM — a non-clean exit, never a silent success.
      expect(outcome.prompt).not.toBeNull();
      expect(outcome.cleanExit).toBe(false);

      // Wait well past the (shortened) hard-kill grace: if the close handler
      // failed to clear the timers, a group SIGKILL would fire here against
      // whatever now owns the PGID.
      await new Promise((resolve) => setTimeout(resolve, 300));

      const groupKills = spy.mock.calls.filter(([pid]) => typeof pid === "number" && pid < 0);
      expect(groupKills.filter(([, signal]) => signal === "SIGTERM")).toHaveLength(1);
      expect(groupKills.filter(([, signal]) => signal === "SIGKILL")).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });
});
