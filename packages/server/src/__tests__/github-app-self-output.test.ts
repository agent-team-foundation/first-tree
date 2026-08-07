import { GITHUB_TASK_REPLY_RUN_MARKER_PREFIX } from "@first-tree/shared";
import { describe, expect, it } from "vitest";
import {
  hasValidGithubTaskReplyRunMarker,
  isGithubAppSelfOutput,
  isGithubAppTargetLogin,
} from "../services/github-app-self-output.js";

const RUN_ID = "019f63c6-b7ba-7a41-80ac-88077c9a8dbb";
const MARKER = `${GITHUB_TASK_REPLY_RUN_MARKER_PREFIX}${RUN_ID} -->`;

describe("isGithubAppTargetLogin", () => {
  it("matches the configured App slug with or without a [bot] suffix", () => {
    expect(isGithubAppTargetLogin("First-Tree", "first-tree")).toBe(true);
    expect(isGithubAppTargetLogin("FIRST-TREE[bot]", "first-tree")).toBe(true);
    expect(isGithubAppTargetLogin("first-tree-helper", "first-tree")).toBe(false);
    expect(isGithubAppTargetLogin("first-tree", null)).toBe(false);
  });
});

describe("hasValidGithubTaskReplyRunMarker", () => {
  it("accepts only a complete UUID marker", () => {
    expect(hasValidGithubTaskReplyRunMarker(`done\n${MARKER}`)).toBe(true);
    expect(hasValidGithubTaskReplyRunMarker(`${GITHUB_TASK_REPLY_RUN_MARKER_PREFIX}not-a-uuid -->`)).toBe(false);
    expect(hasValidGithubTaskReplyRunMarker("no marker")).toBe(false);
  });
});

describe("isGithubAppSelfOutput", () => {
  function commentPayload(input: { login: string; type: string; body: string }): Record<string, unknown> {
    return {
      comment: {
        body: input.body,
        user: { login: input.login, type: input.type },
      },
    };
  }

  it("requires the configured App Bot identity AND a valid task-reply run marker", () => {
    expect(
      isGithubAppSelfOutput({
        appSlug: "first-tree",
        eventType: "issue_comment",
        action: "created",
        payload: commentPayload({
          login: "first-tree[bot]",
          type: "Bot",
          body: `Terminal reply\n${MARKER}`,
        }),
      }),
    ).toBe(true);
  });

  it("does not treat an App Bot comment without a run marker as self-output", () => {
    expect(
      isGithubAppSelfOutput({
        appSlug: "first-tree",
        eventType: "issue_comment",
        action: "created",
        payload: commentPayload({
          login: "first-tree[bot]",
          type: "Bot",
          body: "Trusted Context Review published this without a task-reply marker.",
        }),
      }),
    ).toBe(false);
  });

  it("does not treat a marker alone as self-output without the configured App Bot", () => {
    expect(
      isGithubAppSelfOutput({
        appSlug: "first-tree",
        eventType: "issue_comment",
        action: "edited",
        payload: commentPayload({
          login: "someone-else[bot]",
          type: "Bot",
          body: `Borrowed marker\n${MARKER}`,
        }),
      }),
    ).toBe(false);
    expect(
      isGithubAppSelfOutput({
        appSlug: "first-tree",
        eventType: "issue_comment",
        action: "created",
        payload: commentPayload({
          login: "first-tree[bot]",
          type: "User",
          body: `Human borrowed the slug\n${MARKER}`,
        }),
      }),
    ).toBe(false);
    expect(
      isGithubAppSelfOutput({
        appSlug: "first-tree",
        eventType: "issue_comment",
        action: "created",
        payload: commentPayload({
          login: "first-tree",
          type: "Bot",
          body: `Bare slug is not the App bot identity\n${MARKER}`,
        }),
      }),
    ).toBe(false);
  });

  it("fails closed when the deployment App slug is missing", () => {
    expect(
      isGithubAppSelfOutput({
        appSlug: null,
        eventType: "issue_comment",
        action: "created",
        payload: commentPayload({
          login: "first-tree[bot]",
          type: "Bot",
          body: `Terminal reply\n${MARKER}`,
        }),
      }),
    ).toBe(false);
  });
});
