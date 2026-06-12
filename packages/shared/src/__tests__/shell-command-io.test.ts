import { describe, expect, it } from "vitest";
import { classifyShellCommandIo, stripShellCommandDisplayWrapper } from "../shell-command-io.js";

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

  // Codex CLI wraps every command in `/bin/<login-shell> -lc '<inner>'` before
  // it surfaces in the `command_execution` thread item — bash on Linux daemons,
  // zsh on macOS daemons, sh on minimal images. Without unwrapping these
  // wrappers, codex's only file-read signal lands in MUTATING_OR_AMBIGUOUS_TOOLS
  // and the Context tab dashboard sees zero codex usage (see PR description for
  // the empirical event-payload that drove this fix).
  describe("unwraps login-shell wrappers (codex /bin/<shell> -lc form)", () => {
    it("unwraps /bin/zsh -lc 'sed ...' (codex macOS form) to a read", () => {
      // Real payload pulled from a codex session_events row on macOS.
      expect(classifyShellCommandIo("/bin/zsh -lc \"sed -n '1,7p' /Users/op/.first-tree/tree/NODE.md\"")).toEqual({
        supported: true,
        action: "read",
        commandName: "sed",
        pathArgs: [{ raw: "/Users/op/.first-tree/tree/NODE.md", pathKindHint: "file" }],
      });
    });

    it("unwraps /bin/bash -lc 'cat ...' (codex Linux form) to a read", () => {
      expect(classifyShellCommandIo("/bin/bash -lc 'cat /home/op/.first-tree/tree/NODE.md'")).toEqual({
        supported: true,
        action: "read",
        commandName: "cat",
        pathArgs: [{ raw: "/home/op/.first-tree/tree/NODE.md", pathKindHint: "file" }],
      });
    });

    it("unwraps sh -c 'rg --files ...' (minimal image form) to a read", () => {
      expect(classifyShellCommandIo("sh -c 'rg --files /tree/practices'")).toEqual({
        supported: true,
        action: "read",
        commandName: "rg",
        pathArgs: [{ raw: "/tree/practices", pathKindHint: "directory" }],
      });
    });

    it("preserves the inner-command rejection — wrapped mutating tool still rejected", () => {
      // The whole point of the wrapper unwrap is that whatever the inner tool
      // is decides the verdict — not the outer shell. A wrapped `tee` (write)
      // must remain rejected as a mutation, not silently classified as read.
      expect(classifyShellCommandIo("/bin/zsh -lc 'tee /tree/NODE.md'")).toEqual({
        supported: false,
        reason: "write_or_mutation",
        commandName: "tee",
      });
    });

    it("preserves the inner-command rejection — wrapped pipeline still complex_shell", () => {
      expect(classifyShellCommandIo("/bin/bash -lc 'cat /tree/NODE.md | head'")).toEqual({
        supported: false,
        reason: "complex_shell",
      });
    });

    it("preserves the inner-command rejection — wrapped sed -i still mutation", () => {
      expect(classifyShellCommandIo("/bin/bash -lc \"sed -i 's/a/b/' /tree/NODE.md\"")).toEqual({
        supported: false,
        reason: "write_or_mutation",
        commandName: "sed",
      });
    });

    it("rejects a wrapper with no inner command as write_or_mutation (not a read)", () => {
      // `zsh -lc` with nothing after isn't a "read of a tree file" — fall
      // through to the standard mutating-shell rejection so we don't silently
      // promote a malformed wrapper into a phony read.
      expect(classifyShellCommandIo("/bin/zsh -lc")).toEqual({
        supported: false,
        reason: "write_or_mutation",
        commandName: "zsh",
      });
    });

    it("rejects a wrapper whose flag is not -c / -lc", () => {
      // `bash -x cat foo` is NOT the wrapper pattern — must NOT unwrap and
      // re-classify; the outer bash invocation can do arbitrary things, so
      // it stays in the mutating rejection.
      expect(classifyShellCommandIo("/bin/bash -x cat /tree/NODE.md")).toEqual({
        supported: false,
        reason: "write_or_mutation",
        commandName: "bash",
      });
    });

    it("does not unwrap when the inner script is dynamic ($VAR / backticks)", () => {
      // The inner token came from a double-quoted shell string that included
      // `$VAR`, so the tokenizer flagged it dynamic. We can't statically know
      // what the inner command resolves to — fall through to mutation
      // rejection rather than analyze a string the agent's shell would
      // re-expand at runtime.
      expect(classifyShellCommandIo('/bin/zsh -lc "cat $TREE/NODE.md"')).toEqual({
        supported: false,
        reason: "write_or_mutation",
        commandName: "zsh",
      });
    });

    it("unwraps a doubly-nested wrapper (bash -lc \"sh -c 'cat ...'\") within the depth budget", () => {
      expect(classifyShellCommandIo("/bin/bash -lc \"sh -c 'cat /tree/NODE.md'\"")).toEqual({
        supported: true,
        action: "read",
        commandName: "cat",
        pathArgs: [{ raw: "/tree/NODE.md", pathKindHint: "file" }],
      });
    });

    it("stops unwrapping past the depth budget (no infinite recursion)", () => {
      // Three nested wrappers — the budget allows two unwraps, so the third
      // outer `bash` is treated as a bare mutating shell. The path stops at a
      // safe rejection rather than recursing forever or unwrapping a
      // pathological chain.
      expect(classifyShellCommandIo('/bin/bash -lc "bash -lc \\"bash -lc \'cat /tree/NODE.md\'\\""')).toMatchObject({
        supported: false,
      });
    });
  });
});

describe("stripShellCommandDisplayWrapper", () => {
  it("strips one codex login-shell wrapper for display", () => {
    expect(stripShellCommandDisplayWrapper("/bin/zsh -lc \"sed -n '1,7p' /Users/op/tree/NODE.md\"")).toBe(
      "sed -n '1,7p' /Users/op/tree/NODE.md",
    );
    expect(stripShellCommandDisplayWrapper("/bin/bash -lc 'cat /home/op/tree/NODE.md'")).toBe(
      "cat /home/op/tree/NODE.md",
    );
    expect(stripShellCommandDisplayWrapper("sh -c 'rg --files /tree'")).toBe("rg --files /tree");
  });

  it("leaves non-wrapper and dynamic-wrapper commands unchanged", () => {
    expect(stripShellCommandDisplayWrapper("sed -n '1,7p' /tree/NODE.md")).toBe("sed -n '1,7p' /tree/NODE.md");
    expect(stripShellCommandDisplayWrapper("/bin/bash -x cat /tree/NODE.md")).toBe("/bin/bash -x cat /tree/NODE.md");
    expect(stripShellCommandDisplayWrapper('/bin/zsh -lc "cat $TREE/NODE.md"')).toBe(
      '/bin/zsh -lc "cat $TREE/NODE.md"',
    );
  });

  it("only strips a single display wrapper", () => {
    expect(stripShellCommandDisplayWrapper("/bin/bash -lc \"sh -c 'cat /tree/NODE.md'\"")).toBe(
      "sh -c 'cat /tree/NODE.md'",
    );
  });
});
