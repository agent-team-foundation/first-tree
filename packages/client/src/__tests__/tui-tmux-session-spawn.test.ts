import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

import {
  capturePane,
  killSession,
  listOwnedSessions,
  listSessions,
  newSession,
  pasteText,
  sendKey,
  sessionExists,
} from "../handlers/claude-code-tui/tmux-session.js";

type FakeChild = EventEmitter & {
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
};

function makeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn();
  return child;
}

function queueChild(outcome: { code?: number | null; stdout?: string; stderr?: string; error?: Error; hangMs?: number }) {
  spawnMock.mockImplementationOnce(() => {
    const child = makeChild();
    if (outcome.hangMs !== undefined) {
      // leave hanging for timeout path
      return child;
    }
    setImmediate(() => {
      if (outcome.error) {
        child.emit("error", outcome.error);
        return;
      }
      if (outcome.stdout) child.stdout.write(outcome.stdout);
      if (outcome.stderr) child.stderr.write(outcome.stderr);
      child.emit("close", outcome.code ?? 0);
    });
    return child;
  });
}

describe("tmux-session spawn helpers", () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("newSession builds tmux args including env and dimensions", async () => {
    queueChild({ code: 0 });
    await newSession({
      name: "ftth-test",
      cwd: "/tmp/ws",
      command: "claude",
      env: { FOO: "bar" },
      width: 100,
      height: 40,
    });
    expect(spawnMock).toHaveBeenCalledWith(
      "tmux",
      expect.arrayContaining([
        "new-session",
        "-d",
        "-s",
        "ftth-test",
        "-x",
        "100",
        "-y",
        "40",
        "-c",
        "/tmp/ws",
        "-e",
        "FOO=bar",
        "claude",
      ]),
      expect.any(Object),
    );
  });

  it("newSession throws when tmux fails", async () => {
    queueChild({ code: 1, stderr: "no server" });
    await expect(
      newSession({ name: "x", cwd: "/tmp", command: "claude" }),
    ).rejects.toThrow(/tmux .* failed/);
  });

  it("pasteText load/paste/enter and cleans buffer on failure", async () => {
    queueChild({ code: 0 }); // load-buffer
    queueChild({ code: 0 }); // paste-buffer
    queueChild({ code: 0 }); // send-keys Enter
    queueChild({ code: 0 }); // delete-buffer finally
    await pasteText("sess", "hello world");
    expect(spawnMock).toHaveBeenCalledTimes(4);
    expect(spawnMock.mock.calls[0]?.[1]?.[0]).toBe("load-buffer");
    expect(spawnMock.mock.calls[1]?.[1]?.[0]).toBe("paste-buffer");
    expect(spawnMock.mock.calls[2]?.[1]).toEqual(expect.arrayContaining(["send-keys", "Enter"]));
  });

  it("pasteText still deletes buffer when paste fails", async () => {
    queueChild({ code: 0 }); // load-buffer
    queueChild({ code: 1, stderr: "paste fail" }); // paste-buffer fails
    queueChild({ code: 0 }); // delete-buffer finally
    await expect(pasteText("sess", "secret")).rejects.toThrow(/paste-buffer/);
    expect(spawnMock.mock.calls.some((c) => c[1]?.[0] === "delete-buffer")).toBe(true);
  });

  it("sendKey / capturePane / sessionExists / killSession / listSessions", async () => {
    queueChild({ code: 0 });
    await sendKey("sess", "Escape");

    queueChild({ code: 0, stdout: "pane\n" });
    await expect(capturePane("sess")).resolves.toBe("pane\n");

    queueChild({ code: 0, stdout: "full\n" });
    await expect(capturePane("sess", true)).resolves.toBe("full\n");
    expect(spawnMock.mock.calls.at(-1)?.[1]).toEqual(expect.arrayContaining(["-S", "-"]));

    queueChild({ code: 0 });
    await expect(sessionExists("sess")).resolves.toBe(true);
    queueChild({ code: 1 });
    await expect(sessionExists("missing")).resolves.toBe(false);

    queueChild({ code: 0 });
    await killSession("sess");

    queueChild({ code: 0, stdout: "a\nb\n\n" });
    await expect(listSessions()).resolves.toEqual(["a", "b"]);
    queueChild({ code: 1, stderr: "no server" });
    await expect(listSessions()).resolves.toEqual([]);
  });

  it("listOwnedSessions filters by prefix", async () => {
    queueChild({ code: 0, stdout: "ftth-aaa-1\nftth-bbb-2\nftth-aaa-3\n" });
    await expect(listOwnedSessions("ftth-aaa-")).resolves.toEqual(["ftth-aaa-1", "ftth-aaa-3"]);
  });

  it("runTmux resolves on spawn error and timeout", async () => {
    queueChild({ error: new Error("ENOENT tmux") });
    await expect(sessionExists("x")).resolves.toBe(false);

    vi.useFakeTimers();
    spawnMock.mockImplementationOnce(() => makeChild());
    const pending = killSession("hang");
    await vi.advanceTimersByTimeAsync(6000);
    await expect(pending).resolves.toBeUndefined();
  });
});
