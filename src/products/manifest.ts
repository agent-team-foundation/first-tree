/**
 * Product manifest — single source of truth for the first-tree product set.
 *
 * The umbrella CLI (src/cli.ts), the skill tooling, and the maintainer
 * validation scripts all iterate this list instead of hard-coding product
 * names. Adding a new product means: create src/products/<name>/, add a
 * matching entry here, and the rest of the machinery picks it up.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type Output = (text: string) => void;
type ProductRunner = (args: string[], output: Output) => Promise<number>;

export interface ProductDefinition {
  /** Subcommand name as typed on the CLI (`first-tree <name> ...`). */
  readonly name: string;
  /** One-line description shown in the umbrella `--help` usage block. */
  readonly description: string;
  /** Lazy loader for the product's CLI entrypoint. */
  readonly load: () => Promise<{ run: ProductRunner }>;
  /** Whether invoking this product should trigger the auto-upgrade check. */
  readonly autoUpgradeOnInvoke: boolean;
  /** Whether this product ships runtime assets under `assets/<name>/`. */
  readonly hasAssets: boolean;
  /** Whether this product ships a skill under `skills/<name>/`. */
  readonly hasSkill: boolean;
}

export const PRODUCTS: readonly ProductDefinition[] = [
  {
    name: "tree",
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
  {
    name: "skill",
    description:
      "Inspect and repair the four bundled first-tree skills (list, doctor, link)",
    load: async () => {
      const mod = await import("./skill/cli.js");
      return { run: (args, output) => mod.runSkill(args, output) };
    },
    autoUpgradeOnInvoke: false,
    hasAssets: false,
    hasSkill: false,
  },
];

export function getProduct(name: string): ProductDefinition | undefined {
  return PRODUCTS.find((p) => p.name === name);
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
