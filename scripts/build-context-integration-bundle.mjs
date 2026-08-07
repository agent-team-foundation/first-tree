#!/usr/bin/env node

import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONTEXT_INTEGRATION_LIMITS = JSON.parse(
  readFileSync(join(REPO_ROOT, "packages", "shared", "src", "context-integration-limits.json"), "utf8"),
);
if (!Number.isSafeInteger(CONTEXT_INTEGRATION_LIMITS.byoAdditionalContextLimit)) {
  throw new Error("Shared BYO additional-context limit must be a safe integer.");
}
const EXTERNAL_SKILLS = ["first-tree-read", "first-tree-write"];
const PLUGIN_NAME = "first-tree-context";
const PROVIDERS = ["claude-code", "codex"];
const ADAPTER_VERSIONS = { "claude-code": "1.0.2", codex: "1.0.1" };

function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(
        "Usage: build-context-integration-bundle.mjs [--out-dir <path>] [--version <semver>] [--channel <prod|staging|dev>] [--core-root <path>] [--core-policy-path <release-relative-path>]",
      );
    }
    args.set(key, value);
  }
  const packageJson = JSON.parse(readFileSync(join(REPO_ROOT, "apps", "cli", "package.json"), "utf8"));
  const buildInfo = readFileSync(join(REPO_ROOT, "apps", "cli", "src", "build-info.ts"), "utf8");
  const sourceChannel = buildInfo.match(/CHANNEL: ChannelName = "(prod|staging|dev)"/)?.[1];
  if (!sourceChannel) throw new Error("Unable to resolve the CLI release channel from apps/cli/src/build-info.ts.");
  return {
    outDir: resolve(args.get("--out-dir") ?? join(REPO_ROOT, "apps", "cli", "context-integration")),
    version: args.get("--version") ?? packageJson.version,
    channel: args.get("--channel") ?? sourceChannel,
    coreRoot: resolve(args.get("--core-root") ?? REPO_ROOT),
    corePolicyPath: args.get("--core-policy-path") ?? "dist/runtime-assets/context-tree-policy.md",
  };
}

function sha256(content) {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function normalizedFiles(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile()) {
        files.push(path);
      } else {
        throw new Error(`Bundle source contains an unsupported entry: ${path}`);
      }
    }
  };
  visit(root);
  return files;
}

function treeDigest(root, filter = () => true) {
  const hash = createHash("sha256");
  for (const path of normalizedFiles(root)) {
    const name = relative(root, path).split("\\").join("/");
    if (!filter(name)) continue;
    hash.update(name);
    hash.update("\0");
    hash.update(readFileSync(path));
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function renderCoreLoaderContract(provider, name) {
  return `1. For every new First Tree Context task, run the current loader:\n\n\`\`\`sh\n__FIRST_TREE_SKILL_INVOCATION__ --json context skill load --protocol 1 --provider ${provider} --name ${name}\n\`\`\`\n\n2. Require a valid protocol-v1 response for \`consumerKind: byo\`, provider \`${provider}\`, Skill \`${name}\`, and both \`skillDigest\` and \`policyDigest\`. The loader is the only authority that validates the exact release, contained paths, and actual file digests; do not run an independent \`sha256sum\`.\n3. Resolve the returned Skill and Policy independently:\n   - Reuse Skill content only when the exact \`(${name}, skillDigest)\` pair was previously read in full and that full text is still directly available in the current provider context.\n   - Reuse Policy content only when the exact \`policyDigest\` was previously read in full and that full text is still directly available in the current provider context. Read and Write may share only this Policy reuse.\n   - Otherwise read the corresponding current \`skillPath\` or \`policyPath\` completely. A matching path, Skill name, release version, or summary that content was loaded is not evidence that the full text remains available. Treat uncertainty, digest changes, and unavailable content after startup, resume, clear, or compact as a cache miss.\n4. Follow the canonical workflow validated by this latest loader response. Do not create a persistent Core cache. Missing, invalid, or rejected loader output means First Tree Context is unavailable; do not fall back to a copied or legacy workflow.`;
}

function writeThinSkills(pluginRoot, provider) {
  const target = join(pluginRoot, "skills");
  mkdirSync(target, { recursive: true });
  for (const name of EXTERNAL_SKILLS) {
    const skillTarget = join(target, name);
    mkdirSync(skillTarget, { recursive: true });
    const description =
      name === "first-tree-read"
        ? `Load the current First Tree release's canonical task-scoped Context reader for ${provider}.`
        : `Load the current First Tree release's canonical source-backed Context writer for ${provider}.`;
    writeFileSync(
      join(skillTarget, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${description}\n---\n\n# First Tree Context loader\n\n${renderCoreLoaderContract(provider, name)}\n`,
    );
  }
  writeManualActivationSkill(pluginRoot, provider);
}

function writeManualActivationSkill(pluginRoot, provider) {
  const target = join(pluginRoot, "skills", "first-tree");
  mkdirSync(target, { recursive: true });
  writeFileSync(
    join(target, "SKILL.md"),
    `---
name: first-tree
description: Manually activate First Tree Team Context for the current ${provider} project, including pathless sessions. Use when the user asks to enable, activate, or use First Tree Context in the current session.
---

# Activate First Tree Context

## Load canonical Core

${renderCoreLoaderContract(provider, "first-tree-read")}

## Preserve project identity

Preserve the current session's original project identity even if shell cwd has changed:
${
  provider === "claude-code"
    ? '   - Use `--project-root "<host-confirmed-Claude-project-root>"` for an attached Claude Code project, or `--pathless` only when the Claude host confirms the session is pathless. Never derive the root from shell `pwd`/cwd or assume `CLAUDE_PROJECT_DIR` exists in an ordinary shell command.'
    : '   - Use `--pathless` when the current Codex App session is projectless; otherwise use `--project-root "<original-attached-project-root>"`. Do not reclassify from the current shell cwd and do not copy or reproduce the Codex scratch-path heuristic; the CLI remains the only classifier used by setup and Hook activation.'
}
`,
  );
}

function writeSessionStartHook(pluginRoot, provider) {
  const binDir = join(pluginRoot, "bin");
  mkdirSync(binDir, { recursive: true });
  const script = join(binDir, "context-session-start");
  writeFileSync(
    script,
    ["#!/bin/sh", "set -eu", `exec __FIRST_TREE_INVOCATION__ context activate --provider ${provider} "$@"`, ""].join(
      "\n",
    ),
  );
  chmodSync(script, 0o755);

  writeJson(join(pluginRoot, "hooks", "hooks.json"), {
    hooks: {
      SessionStart: [
        {
          matcher: "startup|resume|clear|compact",
          hooks: [
            {
              type: "command",
              command:
                provider === "codex"
                  ? `"\${PLUGIN_ROOT}/bin/context-session-start" --adapter-digest __ADAPTER_DIGEST__`
                  : `"\${CLAUDE_PLUGIN_ROOT}/bin/context-session-start" --adapter-digest __ADAPTER_DIGEST__`,
              timeout: 5,
              statusMessage: "Connecting First Tree Context",
              additionalContextLimit: CONTEXT_INTEGRATION_LIMITS.byoAdditionalContextLimit,
            },
          ],
        },
      ],
    },
  });
}

function writeClaudeBundle(providerRoot, marketplaceName) {
  const pluginRoot = join(providerRoot, "plugins", PLUGIN_NAME);
  writeThinSkills(pluginRoot, "claude-code");
  writeSessionStartHook(pluginRoot, "claude-code");
  writeJson(join(pluginRoot, ".claude-plugin", "plugin.json"), {
    name: PLUGIN_NAME,
    version: ADAPTER_VERSIONS["claude-code"],
    description: "Use explicit-Team First Tree Context in Claude Code without joining the First Tree Agent runtime.",
    author: { name: "First Tree" },
    homepage: "https://first-tree.ai",
    repository: "https://github.com/agent-team-foundation/first-tree",
    license: "Apache-2.0",
    skills: "./skills/",
  });
  writeJson(join(providerRoot, ".claude-plugin", "marketplace.json"), {
    name: marketplaceName,
    owner: { name: "First Tree" },
    plugins: [
      {
        name: PLUGIN_NAME,
        source: "./plugins/first-tree-context",
        description: "Read and update explicit-Team First Tree Context from Claude Code.",
        version: ADAPTER_VERSIONS["claude-code"],
      },
    ],
  });
  return pluginRoot;
}

function writeCodexBundle(providerRoot, marketplaceName) {
  const pluginRoot = join(providerRoot, "plugins", PLUGIN_NAME);
  writeThinSkills(pluginRoot, "codex");
  writeSessionStartHook(pluginRoot, "codex");
  writeJson(join(pluginRoot, ".codex-plugin", "plugin.json"), {
    name: PLUGIN_NAME,
    version: ADAPTER_VERSIONS.codex,
    description: "Use explicit-Team First Tree Context in Codex without joining the First Tree Agent runtime.",
    author: { name: "First Tree", url: "https://first-tree.ai" },
    homepage: "https://first-tree.ai",
    repository: "https://github.com/agent-team-foundation/first-tree",
    license: "Apache-2.0",
    keywords: ["context-tree", "team-context", "coding-agent"],
    skills: "./skills/",
    interface: {
      displayName: "First Tree Context",
      shortDescription: "Bring explicit-Team Context Tree decisions into Codex.",
      longDescription:
        "Read and propose source-backed updates to the Context Tree selected by an explicit First Tree Team handoff.",
      developerName: "First Tree",
      category: "Developer Tools",
      capabilities: ["Read team Context Tree", "Propose source-backed Context Tree updates"],
      websiteURL: "https://first-tree.ai",
      defaultPrompt: [
        "Read the relevant First Tree Context before working on this repository.",
        "Reflect this source-backed decision into the First Tree Context Tree.",
      ],
    },
  });
  writeJson(join(providerRoot, ".agents", "plugins", "marketplace.json"), {
    name: marketplaceName,
    interface: { displayName: "First Tree" },
    plugins: [
      {
        name: PLUGIN_NAME,
        source: { source: "local", path: "./plugins/first-tree-context" },
        policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
        category: "Developer Tools",
        interface: { displayName: "First Tree Context" },
      },
    ],
  });
  return pluginRoot;
}

export function buildContextIntegrationBundle(rawOptions) {
  const options = {
    ...rawOptions,
    outDir: resolve(rawOptions.outDir),
    coreRoot: resolve(rawOptions.coreRoot ?? REPO_ROOT),
    corePolicyPath: rawOptions.corePolicyPath ?? "dist/runtime-assets/context-tree-policy.md",
  };
  if (!["prod", "staging", "dev"].includes(options.channel)) {
    throw new Error(`Unsupported context integration channel: ${options.channel}`);
  }
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(options.version)) {
    throw new Error(`Context integration version must be SemVer: ${options.version}`);
  }
  if (isAbsolute(options.corePolicyPath) || options.corePolicyPath.split(/[\\/]/u).includes("..")) {
    throw new Error(`Context integration Core Policy path must be release-relative: ${options.corePolicyPath}`);
  }

  rmSync(options.outDir, { recursive: true, force: true });
  mkdirSync(options.outDir, { recursive: true });

  const marketplaceName = options.channel === "prod" ? "first-tree" : `first-tree-${options.channel}`;
  const pluginRoots = {
    "claude-code": writeClaudeBundle(join(options.outDir, "claude-code"), marketplaceName),
    codex: writeCodexBundle(join(options.outDir, "codex"), marketplaceName),
  };
  const policyPath = join(options.coreRoot, "packages", "client", "src", "runtime", "assets", "context-tree-policy.md");
  const policy = readFileSync(policyPath);
  const policyDigest = sha256(policy);
  const coreSkills = Object.fromEntries(
    EXTERNAL_SKILLS.map((name) => {
      const path = join(options.coreRoot, "skills", name, "SKILL.md");
      return [name, { path: `skills/${name}/SKILL.md`, digest: sha256(readFileSync(path)) }];
    }),
  );
  const coreDigest = sha256(
    Buffer.from(
      JSON.stringify({
        policy: policyDigest,
        skills: EXTERNAL_SKILLS.map((name) => [name, coreSkills[name].digest]),
      }),
    ),
  );
  const providers = Object.fromEntries(
    PROVIDERS.map((provider) => [
      provider,
      {
        adapterVersion: ADAPTER_VERSIONS[provider],
        adapterDigest: treeDigest(join(options.outDir, provider)),
        minimumVersion: provider === "claude-code" ? "2.1.121" : "0.144.0",
      },
    ]),
  );
  const bundleDigest = sha256(
    Buffer.from(
      JSON.stringify({
        coreDigest,
        policyDigest,
        providers: PROVIDERS.map((provider) => [provider, providers[provider].adapterDigest]),
      }),
    ),
  );
  const manifest = {
    schemaVersion: 1,
    version: options.version,
    channel: options.channel,
    bundleDigest,
    policyDigest,
    core: {
      digest: coreDigest,
      policy: { path: options.corePolicyPath, digest: policyDigest },
      skills: coreSkills,
    },
    providers,
  };
  writeJson(join(options.outDir, "release-manifest.json"), manifest);
  return { manifest, pluginRoots };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2));
  const { manifest } = buildContextIntegrationBundle(options);
  process.stdout.write(
    `build-context-integration-bundle: ${manifest.channel} ${manifest.version} ${manifest.bundleDigest}\n`,
  );
}
