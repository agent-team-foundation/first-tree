import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import { fail, success } from "../../cli/output.js";
import { planMarkdownImport, titleFromMarkdown } from "../../core/doc-review.js";
import { createSdk } from "../_shared/local-agent.js";
import { parseDocStatus } from "./_shared.js";

interface ImportOptions {
  project?: string;
  status?: string;
  dryRun?: boolean;
  agent?: string;
}

export function registerDocImportCommand(doc: Command): void {
  doc
    .command("import <dir>")
    .description(
      "Bulk-publish every markdown file in a directory (non-recursive). Idempotent: publishes use " +
        "--if-changed semantics, so re-running only adds versions for files whose content changed. " +
        "NODE.md / README.md index files are skipped.",
    )
    .option("--project <project>", "Project label applied to every imported document")
    .option("--status <status>", "Status applied to every imported document (default: draft)")
    .option("--dry-run", "Print the import plan without publishing anything")
    .option("--agent <name>", "Agent name on the First Tree server (default: first configured on this client)")
    .action(async (dir: string, options: ImportOptions) => {
      const status = options.status === undefined ? undefined : parseDocStatus(options.status);

      let files: string[];
      try {
        files = readdirSync(dir, { withFileTypes: true })
          .filter((entry) => entry.isFile())
          .map((entry) => join(dir, entry.name))
          .sort();
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        fail("DIR_UNREADABLE", `Cannot read directory "${dir}": ${msg}`, 2);
      }

      const plan = planMarkdownImport(files);
      if (options.dryRun) {
        success({ dryRun: true, candidates: plan.candidates, skipped: plan.skipped });
        return;
      }

      const sdk = createSdk(options.agent);
      const imported = [];
      for (const candidate of plan.candidates) {
        try {
          const content = readFileSync(candidate.path, "utf8");
          const result = await sdk.publishDoc({
            slug: candidate.slug,
            // First publish requires a title; fall back to the slug when the
            // document carries no heading.
            title: titleFromMarkdown(content) ?? candidate.slug,
            content,
            project: options.project,
            status,
            ifChanged: true,
          });
          imported.push({
            path: candidate.path,
            slug: result.slug,
            version: result.version,
            createdDocument: result.createdDocument,
            createdVersion: result.createdVersion,
          });
        } catch (error) {
          // Fail fast, but never lose the progress report: publishes are
          // idempotent, so fixing the cause and re-running resumes cleanly.
          const msg = error instanceof Error ? error.message : String(error);
          const done =
            imported.length > 0 ? imported.map((entry) => `${entry.slug}@v${entry.version}`).join(", ") : "none";
          fail(
            "IMPORT_PARTIAL",
            `Failed at "${candidate.path}": ${msg}. Imported before the failure: ${done}. ` +
              "Imports are idempotent — fix the cause and re-run to resume.",
            1,
          );
        }
      }
      success({ imported, skipped: plan.skipped });
    });
}
