/**
 * Command manifest — single source of truth for the first-tree CLI surface.
 *
 * The surface splits into two kinds of commands:
 *
 *   - Products: `tree`, `breeze`, `gardener`. Each is a real tool with its
 *     own CLI, its own skill payload under `skills/<name>`, and optional
 *     runtime assets under `assets/<name>`.
 *
 *   - Meta commands: `skill`. These are maintenance tools that operate on the
 *     product suite itself. They don't ship skills or assets, and shouldn't be
 *     treated as products by callers that iterate only the product set.
 */

import { readOwnVersion } from "#shared/version.js";

type Output = (text: string) => void;
type CommandRunner = (args: string[], output: Output) => Promise<number>;

export type CommandKind = "product" | "meta";

export interface CommandDefinition {
  readonly name: string;
  readonly kind: CommandKind;
  readonly description: string;
  readonly load: () => Promise<{ run: CommandRunner }>;
  readonly autoUpgradeOnInvoke: boolean;
  readonly versionDir: string;
}

export interface ProductDefinition extends CommandDefinition {
  readonly kind: "product";
  readonly hasAssets: boolean;
  readonly hasSkill: boolean;
}

export interface MetaDefinition extends CommandDefinition {
  readonly kind: "meta";
}

export const PRODUCTS: readonly ProductDefinition[] = [
  {
    name: "tree",
    kind: "product",
    description: "Context Tree tooling (init, bind, sync, publish, ...)",
    load: async () => {
      const mod = await import("./tree/cli.js");
      return { run: (args, output) => mod.runTree(args, output) };
    },
    autoUpgradeOnInvoke: true,
    versionDir: "src/products/tree",
    hasAssets: true,
    hasSkill: true,
  },
  {
    name: "breeze",
    kind: "product",
    description:
      "Breeze proposal/inbox agent (install, run, status, watch, ...)",
    load: async () => {
      const mod = await import("./breeze/cli.js");
      return { run: (args, output) => mod.runBreeze(args, output) };
    },
    autoUpgradeOnInvoke: false,
    versionDir: "src/products/breeze",
    hasAssets: true,
    hasSkill: true,
  },
  {
    name: "gardener",
    kind: "product",
    description: "Context Tree maintenance agent (respond, comment, ...)",
    load: async () => {
      const mod = await import("./gardener/cli.js");
      return { run: (args, output) => mod.runGardener(args, output) };
    },
    autoUpgradeOnInvoke: false,
    versionDir: "src/products/gardener",
    hasAssets: false,
    hasSkill: true,
  },
];

export const META_COMMANDS: readonly MetaDefinition[] = [
  {
    name: "skill",
    kind: "meta",
    description:
      "Manage the four bundled first-tree skills (install, upgrade, list, doctor, link)",
    load: async () => {
      const mod = await import("#meta/skill-tools/cli.js");
      return { run: (args, output) => mod.runSkill(args, output) };
    },
    autoUpgradeOnInvoke: false,
    versionDir: "src/meta/skill-tools",
  },
];

export const ALL_COMMANDS: readonly CommandDefinition[] = [
  ...PRODUCTS,
  ...META_COMMANDS,
];

export function getProduct(name: string): ProductDefinition | undefined {
  return PRODUCTS.find((p) => p.name === name);
}

export function getMetaCommand(name: string): MetaDefinition | undefined {
  return META_COMMANDS.find((m) => m.name === name);
}

export function getCommand(name: string): CommandDefinition | undefined {
  return ALL_COMMANDS.find((c) => c.name === name);
}

export function listProductNames(): readonly string[] {
  return PRODUCTS.map((p) => p.name);
}

export function listMetaCommandNames(): readonly string[] {
  return META_COMMANDS.map((m) => m.name);
}

export function readCommandVersion(commandName: string): string {
  const command = getCommand(commandName);
  if (!command) {
    return "unknown";
  }
  return readOwnVersion(import.meta.url, command.versionDir);
}
