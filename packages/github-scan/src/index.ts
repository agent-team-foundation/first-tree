export {
  GITHUB_SCAN_USAGE,
  extractBackendFlag,
  runGitHubScan,
} from "./github-scan/cli.js";

export type Output = (text: string) => void;
