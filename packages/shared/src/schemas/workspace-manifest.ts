import { z } from "zod";

/**
 * Schema for `<workspace-root>/.first-tree/workspace.json`.
 *
 * Workspace manifest is the single binding record under the workspace-rooted
 * layout simplification (see first-tree-context: first-tree-skill-cli/
 * workspace-layout-simplification.md). It identifies the tree subdirectory
 * and the explicit list of bound source subdirectories. Tree-side metadata
 * is intentionally absent — the tree's own git remote is authoritative for
 * its URL; the workspace's filesystem and the tree.json sources mirror are
 * derived elsewhere.
 *
 * Constraints:
 *   - `tree` is the immediate subdirectory name (no path separators, no
 *     leading dot, no `..`).
 *   - `sources` entries are immediate subdirectory names with the same
 *     constraints. Duplicates are rejected.
 *   - Sibling subdirectories present on disk but absent from `sources` are
 *     considered unbound and reported by `status`, not auto-promoted.
 *
 * Intentionally NOT in the schema: `bindingMode`, `treeMode`,
 * `schemaVersion`, `sourceId`, `rootKind`, `workspaceId`, `entrypoint`,
 * `remoteUrl`. Each is either a derived classification (tree/binding mode)
 * or available from a more authoritative source (git remote, filesystem).
 */

const subdirectoryNameSchema = z
  .string()
  .min(1, "subdirectory name must be non-empty")
  .refine((value) => !value.includes("/") && !value.includes("\\"), {
    message: "subdirectory name must not contain path separators",
  })
  .refine((value) => value !== "." && value !== "..", {
    message: "subdirectory name must not be '.' or '..'",
  })
  .refine((value) => !value.startsWith("."), {
    message: "subdirectory name must not start with '.'",
  });

export const workspaceManifestSchema = z
  .object({
    tree: subdirectoryNameSchema,
    sources: z.array(subdirectoryNameSchema).refine((values) => new Set(values).size === values.length, {
      message: "sources must not contain duplicate entries",
    }),
  })
  .refine((manifest) => !manifest.sources.includes(manifest.tree), {
    message: "tree subdirectory must not also appear in sources",
    path: ["sources"],
  });

export type WorkspaceManifest = z.infer<typeof workspaceManifestSchema>;

export const WORKSPACE_MANIFEST_FILENAME = "workspace.json";
export const WORKSPACE_STATE_DIRNAME = ".first-tree";
