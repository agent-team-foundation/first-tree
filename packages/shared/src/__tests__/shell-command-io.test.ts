import { describe, expect, it } from "vitest";
import { classifyShellCommandIo } from "../shell-command-io.js";

describe("classifyShellCommandIo", () => {
  it("classifies sed file operands after options and script", () => {
    expect(classifyShellCommandIo("sed -n '1,240p' /tree/NODE.md")).toEqual({
      supported: true,
      action: "read",
      commandName: "sed",
      pathArgs: [{ raw: "/tree/NODE.md", pathKindHint: "file" }],
    });
  });

  it("classifies simple file read commands with relative paths", () => {
    expect(classifyShellCommandIo("cat NODE.md docs/guide.md")).toEqual({
      supported: true,
      action: "read",
      commandName: "cat",
      pathArgs: [
        { raw: "NODE.md", pathKindHint: "file" },
        { raw: "docs/guide.md", pathKindHint: "file" },
      ],
    });
  });

  it("classifies ripgrep files mode directory operands", () => {
    expect(classifyShellCommandIo("rg --files /tree")).toEqual({
      supported: true,
      action: "read",
      commandName: "rg",
      pathArgs: [{ raw: "/tree", pathKindHint: "directory" }],
    });
  });

  it("classifies grep path operands after the pattern", () => {
    expect(classifyShellCommandIo("grep -R Context /tree/practices")).toEqual({
      supported: true,
      action: "read",
      commandName: "grep",
      pathArgs: [{ raw: "/tree/practices", pathKindHint: "unknown" }],
    });
  });

  it("skips grep option values before finding path operands", () => {
    expect(classifyShellCommandIo("grep -R -C 2 --include '*.md' Context /tree")).toEqual({
      supported: true,
      action: "read",
      commandName: "grep",
      pathArgs: [{ raw: "/tree", pathKindHint: "unknown" }],
    });
  });

  it("rejects unsupported grep options instead of guessing path positions", () => {
    expect(classifyShellCommandIo("grep --custom-option value Context /tree")).toEqual({
      supported: false,
      reason: "unsupported_tool",
      commandName: "grep",
    });
  });

  it("rejects complex shell syntax", () => {
    expect(classifyShellCommandIo("cat /tree/NODE.md | head")).toEqual({
      supported: false,
      reason: "complex_shell",
    });
    expect(classifyShellCommandIo("cat /tree/NODE.md > /tmp/out")).toEqual({
      supported: false,
      reason: "complex_shell",
    });
  });

  it("rejects dynamic path syntax in path positions", () => {
    expect(classifyShellCommandIo("cat $TREE/NODE.md")).toEqual({
      supported: false,
      reason: "dynamic_path",
      commandName: "cat",
    });
    expect(classifyShellCommandIo("cat /tree/*.md")).toEqual({
      supported: false,
      reason: "dynamic_path",
      commandName: "cat",
    });
  });

  it("rejects mutating commands and sed in-place edits", () => {
    expect(classifyShellCommandIo("tee /tree/NODE.md")).toEqual({
      supported: false,
      reason: "write_or_mutation",
      commandName: "tee",
    });
    expect(classifyShellCommandIo("sed -i 's/a/b/' /tree/NODE.md")).toEqual({
      supported: false,
      reason: "write_or_mutation",
      commandName: "sed",
    });
  });

  it("rejects find expressions with mutating action primaries", () => {
    expect(classifyShellCommandIo("find /tree -delete")).toEqual({
      supported: false,
      reason: "write_or_mutation",
      commandName: "find",
    });
    expect(classifyShellCommandIo("find /tree -exec rm {} \\;")).toEqual({
      supported: false,
      reason: "write_or_mutation",
      commandName: "find",
    });
  });

  it("rejects unquoted shell comments instead of parsing comment text as paths", () => {
    expect(classifyShellCommandIo("cat NODE.md # docs/secret.md")).toEqual({
      supported: false,
      reason: "complex_shell",
    });
  });

  it("rejects commands without explicit path operands", () => {
    expect(classifyShellCommandIo("rg Context")).toEqual({
      supported: false,
      reason: "no_explicit_path",
      commandName: "rg",
    });
    expect(classifyShellCommandIo("ls")).toEqual({
      supported: false,
      reason: "no_explicit_path",
      commandName: "ls",
    });
    expect(classifyShellCommandIo("cat -")).toEqual({
      supported: false,
      reason: "no_explicit_path",
      commandName: "cat",
    });
  });
});
