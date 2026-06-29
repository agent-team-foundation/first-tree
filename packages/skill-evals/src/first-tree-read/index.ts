import { runFirstTreeReadLegacyCli } from "../suites/first-tree-read/index.js";

runFirstTreeReadLegacyCli(process.argv.slice(2)).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
