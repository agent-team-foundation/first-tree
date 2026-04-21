import { describe, expect, it } from "vitest";

import {
  collectLaunchdPassthroughEnvVars,
  escapeXml,
  launchdLabel,
  launchdPlistPath,
  renderLaunchdPlist,
} from "../../src/products/breeze/engine/daemon/launchd.js";
import {
  defaultDaemonArgs,
  resolveSelfCliInvocation,
} from "../../src/products/breeze/engine/commands/start.js";

describe("launchdLabel", () => {
  it("sanitizes login and profile into a dotted reverse-dns label", () => {
    expect(launchdLabel("bingran-you", "default")).toBe(
      "com.breeze.runner.bingran-you.default",
    );
  });

  it("replaces filesystem-unsafe characters", () => {
    expect(launchdLabel("alice@home", "prof/test")).toBe(
      "com.breeze.runner.alice_home.prof_test",
    );
  });
});

describe("launchdPlistPath", () => {
  it("lives under <runnerHome>/launchd/<label>.plist", () => {
    const label = launchdLabel("alice", "default");
    expect(launchdPlistPath("/var/home/runner", label)).toBe(
      `/var/home/runner/launchd/${label}.plist`,
    );
  });
});

describe("escapeXml", () => {
  it("escapes the five predefined XML entities", () => {
    expect(escapeXml(`a&b<c>d"e'`)).toBe("a&amp;b&lt;c&gt;d&quot;e&apos;");
  });
});

describe("renderLaunchdPlist", () => {
  it("produces a well-formed plist with KeepAlive and RunAtLoad", () => {
    const xml = renderLaunchdPlist({
      login: "alice",
      profile: "default",
      executable: "/usr/local/bin/first-tree",
      arguments: ["breeze", "daemon", "--backend=ts"],
      logPath: "/tmp/breeze.log",
      env: { PATH: "/opt/bin", HOME: "/Users/alice" },
    });
    expect(xml).toContain("<string>com.breeze.runner.alice.default</string>");
    expect(xml).toContain("<key>KeepAlive</key>");
    expect(xml).toContain("<true/>");
    expect(xml).toContain("<key>RunAtLoad</key>");
    expect(xml).toContain(
      "<string>/usr/local/bin/first-tree</string>",
    );
    expect(xml).toContain("<string>breeze</string>");
    expect(xml).toContain("<string>--backend=ts</string>");
    expect(xml).toContain("<string>/tmp/breeze.log</string>");
    expect(xml).toContain("<key>PATH</key>");
    expect(xml).toContain("<string>/opt/bin</string>");
    expect(xml).toContain("<key>HOME</key>");
    expect(xml).toContain("<string>/Users/alice</string>");
  });

  it("escapes special characters inside arguments and env values", () => {
    const xml = renderLaunchdPlist({
      login: "alice",
      profile: "default",
      executable: "/usr/local/bin/first-tree",
      arguments: ["--note", "hello <world> & 'friends'"],
      logPath: "/tmp/x",
      env: { PATH: "/a", HOME: "/b" },
    });
    expect(xml).toContain("hello &lt;world&gt; &amp; &apos;friends&apos;");
  });

  it("includes discovered provider auth env vars beyond the static allowlist", () => {
    const xml = renderLaunchdPlist({
      login: "alice",
      profile: "default",
      executable: "/usr/local/bin/first-tree",
      arguments: ["breeze", "daemon", "--backend=ts"],
      logPath: "/tmp/breeze.log",
      env: {
        PATH: "/opt/bin",
        HOME: "/Users/alice",
        AZURE_OPENAI_API_KEY_TEST: "test-slot-key",
        AWS_PROFILE: "bedrock-profile",
      },
    });
    expect(xml).toContain("<key>AZURE_OPENAI_API_KEY_TEST</key>");
    expect(xml).toContain("<string>test-slot-key</string>");
    expect(xml).toContain("<key>AWS_PROFILE</key>");
    expect(xml).toContain("<string>bedrock-profile</string>");
  });
});

describe("collectLaunchdPassthroughEnvVars", () => {
  it("preserves the legacy allowlist and appends prefixed provider envs", () => {
    const vars = collectLaunchdPassthroughEnvVars(
      {
        AZURE_OPENAI_API_KEY_TEST: "test",
        OPENAI_BASE_URL: "https://example.test",
        AWS_PROFILE: "bedrock",
        CLAUDE_CODE_USE_BEDROCK: "1",
        CODEX_THREAD_ID: "thread-123",
      },
      ["GOOGLE_APPLICATION_CREDENTIALS"],
    );
    expect(vars).toContain("CLAUDE_CODE_USE_BEDROCK");
    expect(vars).toContain("AZURE_OPENAI_API_KEY_TEST");
    expect(vars).toContain("OPENAI_BASE_URL");
    expect(vars).toContain("AWS_PROFILE");
    expect(vars).toContain("GOOGLE_APPLICATION_CREDENTIALS");
    expect(vars).not.toContain("CODEX_THREAD_ID");
  });
});

describe("start command self-invocation helpers", () => {
  it("resolves the current node + cli entrypoint pair", () => {
    const self = resolveSelfCliInvocation("/opt/first-tree/dist/cli.js");
    expect(self.executable).toBe(process.execPath);
    expect(self.prefixArgs).toEqual(["/opt/first-tree/dist/cli.js"]);
  });

  it("prepends the cli entrypoint before breeze daemon args", () => {
    expect(
      defaultDaemonArgs(["--allow-repo", "owner/repo"], [
        "/opt/first-tree/dist/cli.js",
      ]),
    ).toEqual([
      "/opt/first-tree/dist/cli.js",
      "breeze",
      "daemon",
      "--backend=ts",
      "--allow-repo",
      "owner/repo",
    ]);
  });
});
