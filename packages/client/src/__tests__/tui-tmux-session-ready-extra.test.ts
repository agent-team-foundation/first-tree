import { describe, expect, it } from "vitest";
import { waitForReady } from "../handlers/claude-code-tui/tmux-session.js";

const readyPane = ['❯ Try "edit <filepath> to..."', "⏵⏵ bypass permissions on (shift+tab to cycle)"].join("\n");

describe("waitForReady prompt handling", () => {
  it("accepts the workspace trust prompt once before waiting for ready", async () => {
    const trustPane = [
      "Quick safety check: Is this a project you created or one you trust?",
      " ❯ 1. Yes, I trust this folder",
      "   2. No, exit",
      "Enter to confirm · Esc to cancel",
    ].join("\n");
    const sent: string[] = [];
    let polls = 0;

    await expect(
      waitForReady({
        name: "ftth-trust",
        timeoutMs: 1_000,
        pollIntervalMs: 1,
        capture: async () => (polls++ === 0 ? trustPane : readyPane),
        send: async (_name, key) => {
          sent.push(key);
        },
      }),
    ).resolves.toBeUndefined();

    expect(sent).toEqual(["Enter"]);
  });

  it("selects resume-from-summary and extends the ready deadline", async () => {
    const resumePane = [
      "This session is 2h 41m old and 119.5k tokens.",
      " ❯ 1. Resume from summary (recommended)",
      "   2. Resume full session as-is",
      "   3. Don't ask me again",
      "Enter to confirm · Esc to cancel",
    ].join("\n");
    const sent: string[] = [];
    let polls = 0;

    await expect(
      waitForReady({
        name: "ftth-resume",
        timeoutMs: 1_000,
        pollIntervalMs: 1,
        summaryReadyTimeoutMs: 2_000,
        capture: async () => (polls++ === 0 ? resumePane : readyPane),
        send: async (_name, key) => {
          sent.push(key);
        },
      }),
    ).resolves.toBeUndefined();

    expect(sent).toEqual(["1", "Enter"]);
  });

  it("throws a bounded timeout error when no ready surface appears", async () => {
    await expect(
      waitForReady({
        name: "ftth-timeout",
        timeoutMs: 0,
        capture: async () => "still starting",
      }),
    ).rejects.toThrow(/claude TUI did not become ready within \d+ms \(session=ftth-timeout\)/);
  });
});
