/**
 * Command manifest — single source of truth for the first-tree CLI surface.
 *
 * The surface splits into two kinds of commands:
 *
 *   - Products: `tree`, `breeze`, `gardener`. Each is a real tool with its
 *     own CLI, its own skill payload under `skills/<name>/`, and optional
 *     runtime assets under `assets/<name>/`. These are what users mean
 *     when they say "a first-tree product".
 *
 *   - Meta commands: `skill`. These are maintenance/diagnostic tools that
 *     operate on the product suite itself. They don't ship skills or
 *     assets, aren't subject to auto-upgrade, and shouldn't be treated as
 *     products by callers that iterate the product set.
 *
 * The umbrella CLI (src/cli.ts) and maintainer scripts should iterate
 * `PRODUCTS` for product-level logic (help listing, version reporting,
 * auto-upgrade) and `META_COMMANDS` when they want the full dispatch
 * surface. `ALL_COMMANDS` is the concatenation for lookup.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type Output = (text: string) => void;
type CommandRunner = (args: string[], output: Output) => Promise<number>;

export type CommandKind = "product" | "meta";

export interface CommandDefinition {
  /** Subcommand name as typed on the CLI (`first-tree <name> ...`). */
  readonly name: string;
  /** `product` = real tool; `meta` = maintenance/diagnostic command. */
  readonly kind: CommandKind;
  /** One-line description shown in the umbrella `--help` usage block. */
  readonly description: string;
  /** Lazy loader for the command's CLI entrypoint. */
  readonly load: () => Promise<{ run: CommandRunner }>;
  /** Whether invoking this command should trigger the auto-upgrade check. */
  readonly autoUpgradeOnInvoke: boolean;
}

export interface ProductDefinition extends CommandDefinition {
  readonly kind: "product";
  /** Whether this product ships runtime assets under `assets/<name>/`. */
  readonly hasAssets: boolean;
  /** Whether this product ships a skill under `skills/<name>/`. */
  readonly hasSkill: boolean;
}

export interface MetaDefinition extends CommandDefinition {
  readonly kind: "meta";
}

export const PRODUCTS: readonly ProductDefinition[] = [
  {
    name: "tree",
    kind: "product",
    description:
      "Context Tree tooling (init, bind, sync, publish, ...)",
    load: async () => {
      const mod = await import("./tree/cli.js");
      return { run: (args, output) => mod.runTree(args, output) };
    },
    autoUpgradeOnInvoke: true,
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
    hasAssets: true,
    hasSkill: true,
  },
  {
    name: "gardener",
    kind: "product",
    description:
      "Context Tree maintenance agent (respond, comment, ...)",
    load: async () => {
      const mod = await import("./gardener/cli.js");
      return { run: (args, output) => mod.runGardener(args, output) };
    },
    autoUpgradeOnInvoke: false,
    hasAssets: false,
    hasSkill: true,
  },
];

export const META_COMMANDS: readonly MetaDefinition[] = [
  {
    name: "skill",
    kind: "meta",
    description:
      "Inspect and repair the four bundled first-tree skills (list, doctor, link)",
    load: async () => {
      const mod = await import("#meta/skill-tools/cli.js");
      return { run: (args, output) => mod.runSkill(args, output) };
    },
    autoUpgradeOnInvoke: false,
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

/**
 * Read a product's VERSION file. VERSION files live as siblings of the
 * bundled product cli.ts. When the CLI runs from the published package
 * they are under `dist/products/<name>/`; in the source tree they are
 * under `src/products/<name>/`. We probe both.
 */
export function readProductVersion(productName: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, productName, "VERSION"),
    join(here, "..", "..", "src", "products", productName, "VERSION"),
    join(here, "..", "products", productName, "VERSION"),
  ];
  for (const candidate of candidates) {
    try {
      return readFileSync(candidate, "utf-8").trim();
    } catch {
      // try next
    }
  }
  return "unknown";
}
