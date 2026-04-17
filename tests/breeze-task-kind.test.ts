import { describe, expect, it } from "vitest";

import {
  classifyNotification,
  priorityFor,
  shouldProcessReason,
  taskKindFromString,
  type TaskKind,
} from "../src/products/breeze/engine/runtime/task-kind.js";

describe("classifyNotification", () => {
  it("returns review_request when reason=review_requested even on Issue subjects", () => {
    expect(classifyNotification("PullRequest", "review_requested")).toBe(
      "review_request",
    );
    expect(classifyNotification("Issue", "review_requested")).toBe(
      "review_request",
    );
  });

  it("maps mention and team_mention to mention", () => {
    expect(classifyNotification("Issue", "mention")).toBe("mention");
    expect(classifyNotification("PullRequest", "team_mention")).toBe("mention");
  });

  it("classifies Discussion subjects as discussion", () => {
    expect(classifyNotification("Discussion", "subscribed")).toBe("discussion");
  });

  it("classifies assign by subject type", () => {
    expect(classifyNotification("PullRequest", "assign")).toBe(
      "assigned_pull_request",
    );
    expect(classifyNotification("Issue", "assign")).toBe("assigned_issue");
  });

  it("classifies comment/author/manual as comment", () => {
    expect(classifyNotification("Issue", "author")).toBe("comment");
    expect(classifyNotification("PullRequest", "manual")).toBe("comment");
    expect(classifyNotification("Issue", "comment")).toBe("comment");
  });

  it("returns other for unknown reasons", () => {
    expect(classifyNotification("Commit", "ci_activity")).toBe("other");
  });
});

describe("priorityFor", () => {
  it("ranks in the canonical Rust order", () => {
    expect(priorityFor("review_request", "review_requested")).toBe(100);
    expect(priorityFor("mention", "mention")).toBe(95);
    expect(priorityFor("discussion", "subscribed")).toBe(90);
    expect(priorityFor("comment", "comment")).toBe(85);
    expect(priorityFor("assigned_pull_request", "assign")).toBe(80);
    expect(priorityFor("assigned_issue", "assign")).toBe(70);
    expect(priorityFor("other", "ci_activity")).toBe(50);
    expect(priorityFor("other", "review_requested")).toBe(100);
  });
});

describe("shouldProcessReason", () => {
  it("accepts the actionable set", () => {
    for (const r of [
      "review_requested",
      "mention",
      "team_mention",
      "comment",
      "assign",
      "author",
      "manual",
    ]) {
      expect(shouldProcessReason(r)).toBe(true);
    }
  });

  it("rejects subscribed / ci_activity / empty", () => {
    expect(shouldProcessReason("subscribed")).toBe(false);
    expect(shouldProcessReason("ci_activity")).toBe(false);
    expect(shouldProcessReason("")).toBe(false);
  });
});

describe("taskKindFromString round trip", () => {
  it("maps every kind back to itself", () => {
    const kinds: TaskKind[] = [
      "review_request",
      "mention",
      "comment",
      "assigned_issue",
      "assigned_pull_request",
      "discussion",
      "other",
    ];
    for (const kind of kinds) {
      expect(taskKindFromString(kind)).toBe(kind);
    }
  });

  it("returns undefined for unknown strings", () => {
    expect(taskKindFromString("not_a_kind")).toBeUndefined();
  });
});
