import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DocSummary } from "@first-tree/shared";
import type { Command } from "commander";
import { fail, success } from "../../cli/output.js";
import { errorMessage } from "../../core/error-message.js";
import { createSdk, handleSdkError } from "../_shared/local-agent.js";
import { parseDocStatus } from "./_shared.js";

interface ExportOptions {
  project?: string;
  status?: string;
  agent?: string;
}

export function registerDocExportCommand(doc: Command): void {
  doc
    .command("export <dir>")
    .description(
      "Export the org's document library to a directory: one <slug>.md per document (latest version) " +
        "plus manifest.json with the metadata. The library never locks data in — this is the way out.",
    )
    .option("--project <project>", "Only export documents with this project label")
    .option("--status <status>", "Only export documents in this status")
    .option("--agent <name>", "Agent name on the First Tree server (default: first configured on this client)")
    .action(async (dir: string, options: ExportOptions) => {
      const status = options.status === undefined ? undefined : parseDocStatus(options.status);

      try {
        mkdirSync(dir, { recursive: true });
      } catch (error) {
        const msg = errorMessage(error);
        fail("DIR_UNWRITABLE", `Cannot create directory "${dir}": ${msg}`, 2);
      }

      try {
        const sdk = createSdk(options.agent);
        const summaries: DocSummary[] = [];
        let cursor: string | undefined;
        do {
          const page = await sdk.listDocs({ project: options.project, status, limit: 200, cursor });
          summaries.push(...page.items);
          cursor = page.nextCursor ?? undefined;
        } while (cursor);

        for (const summary of summaries) {
          const full = await sdk.getDoc(summary.id);
          writeFileSync(join(dir, `${summary.slug}.md`), full.version.content);
        }
        const manifest = summaries.map((s) => ({
          slug: s.slug,
          title: s.title,
          project: s.project,
          status: s.status,
          latestVersion: s.latestVersion,
          openCommentCount: s.openCommentCount,
          createdBy: s.createdBy,
          updatedAt: s.updatedAt,
        }));
        writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
        success({ exported: summaries.length, dir });
      } catch (error) {
        handleSdkError(error);
      }
    });
}
