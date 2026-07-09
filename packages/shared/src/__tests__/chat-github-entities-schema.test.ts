import { describe, expect, it } from "vitest";
import {
  chatGithubEntitySchema,
  githubEntityBoundViaSchema,
  isDeclaredBoundVia,
} from "../schemas/chat-github-entities.js";

describe("chat github entity schemas", () => {
  it("normalizes legacy agent_created bindings to agent_declared", () => {
    expect(githubEntityBoundViaSchema.parse("direct")).toBe("direct");
    expect(githubEntityBoundViaSchema.parse("agent_created")).toBe("agent_declared");
    expect(
      chatGithubEntitySchema.parse({
        entityType: "pull_request",
        entityKey: "acme/api#42",
        boundVia: "agent_created",
        htmlUrl: "https://github.com/acme/api/pull/42",
        title: null,
        state: "open",
        number: 42,
      }).boundVia,
    ).toBe("agent_declared");
  });

  it("identifies explicitly declared follow bindings", () => {
    expect(isDeclaredBoundVia("agent_declared")).toBe(true);
    expect(isDeclaredBoundVia("human_declared")).toBe(true);
    expect(isDeclaredBoundVia("direct")).toBe(false);
    expect(isDeclaredBoundVia("agent_created")).toBe(false);
  });
});
