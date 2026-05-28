import { describe, expect, it } from "vitest";
import { isSameModelFamily, mapMcpServers } from "../handlers/claude-code.js";

describe("claude-code handler helpers (Step 6)", () => {
  describe("mapMcpServers", () => {
    it("maps stdio server with args", () => {
      const out = mapMcpServers({
        kind: "claude-code",
        prompt: { append: "" },
        model: "",
        env: [],
        gitRepos: [],
        reasoningEffort: "",
        mcpServers: [{ name: "echo", transport: "stdio", command: "/bin/echo", args: ["-n", "hi"] }],
      });
      expect(out.echo).toEqual({ type: "stdio", command: "/bin/echo", args: ["-n", "hi"] });
    });

    it("maps http server with headers", () => {
      const out = mapMcpServers({
        kind: "claude-code",
        prompt: { append: "" },
        model: "",
        env: [],
        gitRepos: [],
        reasoningEffort: "",
        mcpServers: [
          { name: "remote", transport: "http", url: "https://x.example/y", headers: { Authorization: "Bearer t" } },
        ],
      });
      expect(out.remote).toEqual({
        type: "http",
        url: "https://x.example/y",
        headers: { Authorization: "Bearer t" },
      });
    });

    it("maps sse server", () => {
      const out = mapMcpServers({
        kind: "claude-code",
        prompt: { append: "" },
        model: "",
        env: [],
        gitRepos: [],
        reasoningEffort: "",
        mcpServers: [{ name: "sse-srv", transport: "sse", url: "https://x.example/sse" }],
      });
      expect(out["sse-srv"]).toEqual({ type: "sse", url: "https://x.example/sse", headers: undefined });
    });

    it("returns empty record when no servers", () => {
      expect(
        mapMcpServers({
          kind: "claude-code",
          prompt: { append: "" },
          model: "",
          env: [],
          gitRepos: [],
          reasoningEffort: "",
          mcpServers: [],
        }),
      ).toEqual({});
    });
  });

  describe("isSameModelFamily", () => {
    it("returns true for identical IDs", () => {
      expect(isSameModelFamily("claude-opus-4-6", "claude-opus-4-6")).toBe(true);
    });

    it("returns true for same family different rev", () => {
      expect(isSameModelFamily("claude-opus-4-5", "claude-opus-4-6")).toBe(true);
    });

    it("returns false across families (opus ↔ haiku)", () => {
      expect(isSameModelFamily("claude-opus-4-6", "claude-haiku-4-5")).toBe(false);
    });

    it("returns false across major series", () => {
      expect(isSameModelFamily("claude-opus-3-5", "claude-opus-4-5")).toBe(false);
    });

    it("returns false on empty", () => {
      expect(isSameModelFamily("", "claude-opus-4-6")).toBe(false);
      expect(isSameModelFamily("claude-opus-4-6", "")).toBe(false);
    });

    it("returns false on alias-style IDs (no series segment)", () => {
      expect(isSameModelFamily("opus", "sonnet")).toBe(false);
    });
  });
});
