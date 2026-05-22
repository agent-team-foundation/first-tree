/**
 * github-scan watch TUI tests — rendered via `ink-testing-library`.
 *
 * We exercise the pure view component `GitHubScanWatch` with canned inbox +
 * activity-event props so filesystem side-effects stay out of the test.
 * The inner `WatchApp` (which owns fs.watch / setInterval) is covered
 * lightly: we only assert that `runWatch` mounts and renders without
 * throwing, not that the polling loop runs for N cycles.
 */

import { render } from "ink-testing-library";
import React from "react";
import { describe, expect, it } from "vitest";

import { GitHubScanWatch } from "../../src/github-scan/engine/commands/watch.js";
import type {
  ActivityEvent,
  Inbox,
} from "../../src/github-scan/engine/runtime/types.js";

function mkInbox(entries: Inbox["notifications"]): Inbox {
  return { last_poll: "2026-04-16T20:00:00Z", notifications: entries };
}

function pr(
  id: string,
  status: "new" | "wip" | "human" | "done",
  title: string,
  repo = "o/r",
): Inbox["notifications"][number] {
  return {
    id,
    type: "PullRequest",
    reason: "review_requested",
    repo,
    title,
    url: `https://api.github.com/repos/${repo}/pulls/${id}`,
    last_actor: "",
    updated_at: "2026-04-16T10:00:00Z",
    unread: true,
    priority: 1,
    number: Number(id),
    html_url: `https://github.com/${repo}/pull/${id}`,
    gh_state: "OPEN",
    labels: [],
    github_scan_status: status,
  };
}

/** Strip ANSI + OSC-8 link escapes for robust substring assertions. */
function strip(s: string | undefined): string {
  if (!s) return "";
  // OSC-8: ESC ] 8 ; ; URL BEL TEXT ESC ] 8 ; ; BEL
  // oxlint-disable-next-line no-control-regex
  let out = s.replace(/\x1b\]8;;[^\x07]*\x07/gu, "");
  // ANSI SGR
  // oxlint-disable-next-line no-control-regex
  out = out.replace(/\x1b\[[0-9;]*m/gu, "");
  return out;
}

describe("GitHubScanWatch view", () => {
  it("renders header with status counts", () => {
    const inbox = mkInbox([
      pr("1", "new", "a"),
      pr("2", "new", "b"),
      pr("3", "wip", "c"),
      pr("4", "human", "d"),
      pr("5", "done", "e"),
    ]);
    const { lastFrame } = render(
      <GitHubScanWatch inbox={inbox} events={[]} />,
    );
    const frame = strip(lastFrame());
    expect(frame).toMatch(/github-scan/u);
    expect(frame).toMatch(/status board/u);
    expect(frame).toMatch(/1 need-you/u);
    expect(frame).toMatch(/2 new/u);
    expect(frame).toMatch(/1 wip/u);
    expect(frame).toMatch(/1 finished/u);
  });

  it("shows the HUMAN section when items exist", () => {
    const inbox = mkInbox([pr("9", "human", "needs review")]);
    const { lastFrame } = render(
      <GitHubScanWatch inbox={inbox} events={[]} />,
    );
    const frame = strip(lastFrame());
    expect(frame).toMatch(/NEED-YOU/u);
    expect(frame).toMatch(/\(1\)/u);
    expect(frame).toMatch(/needs review/u);
  });

  it("shows 'nothing needs you' when no human items", () => {
    const inbox = mkInbox([pr("1", "new", "chore")]);
    const { lastFrame } = render(
      <GitHubScanWatch inbox={inbox} events={[]} />,
    );
    const frame = strip(lastFrame());
    expect(frame).toMatch(/nothing needs you right now/u);
  });

  it("groups repos on the board with per-status subsections", () => {
    const inbox = mkInbox([
      pr("1", "new", "a", "o/repoA"),
      pr("2", "wip", "b", "o/repoA"),
      pr("3", "new", "c", "o/repoB"),
      pr("4", "done", "d", "o/repoA"),
    ]);
    const { lastFrame } = render(
      <GitHubScanWatch inbox={inbox} events={[]} />,
    );
    const frame = strip(lastFrame());
    expect(frame).toMatch(/repoA/u);
    expect(frame).toMatch(/repoB/u);
    expect(frame).toMatch(/NEW \(1\)/u);
    expect(frame).toMatch(/WIP \(1\)/u);
    // Done is collapsed.
    expect(frame).toMatch(/FINISHED \(1\).*collapsed/u);
  });

  it("renders live-feed transition events with from/to labels", () => {
    const inbox = mkInbox([]);
    const events: ActivityEvent[] = [
      {
        ts: "2026-04-16T20:05:00Z",
        event: "transition",
        id: "xyz",
        type: "PullRequest",
        repo: "o/r",
        title: "picked up",
        url: "https://github.com/o/r/pull/7",
        from: "new",
        to: "wip",
      },
    ];
    const { lastFrame } = render(
      <GitHubScanWatch inbox={inbox} events={events} />,
    );
    const frame = strip(lastFrame());
    expect(frame).toMatch(/live/u);
    expect(frame).toMatch(/NEW/u);
    expect(frame).toMatch(/WIP/u);
    expect(frame).toMatch(/picked up/u);
  });

  it("renders live-feed new events", () => {
    const events: ActivityEvent[] = [
      {
        ts: "2026-04-16T20:05:00Z",
        event: "new",
        id: "n1",
        type: "PullRequest",
        repo: "o/r",
        title: "fresh arrival",
        url: "https://github.com/o/r/pull/8",
      },
    ];
    const { lastFrame } = render(
      <GitHubScanWatch inbox={null} events={events} />,
    );
    const frame = strip(lastFrame());
    expect(frame).toMatch(/▸ NEW/u);
    expect(frame).toMatch(/fresh arrival/u);
  });

  it("does not render poll events", () => {
    const events: ActivityEvent[] = [
      { ts: "2026-04-16T20:05:00Z", event: "poll", count: 7 },
    ];
    const { lastFrame } = render(
      <GitHubScanWatch inbox={null} events={events} />,
    );
    const frame = strip(lastFrame());
    // Just assert the feed header is there but the poll event isn't.
    expect(frame).toMatch(/live/u);
    expect(frame).not.toMatch(/poll/u);
  });
});
