export {
  extractBackendFlag,
  GITHUB_SCAN_USAGE,
  runGitHubScan,
} from "./github-scan/cli.js";

export type Output = (text: string) => void;
