import { SdkError } from "@first-tree/client";
import { fail } from "../../cli/output.js";
import { handleSdkError } from "../_shared/local-agent.js";

export function handleGitlabSdkError(error: unknown): never {
  if (error instanceof SdkError) {
    if (error.statusCode === 400) {
      fail(
        "INVALID_GITLAB_ENTITY_URL",
        `${error.message} Pass a full GitLab Issue or Merge Request URL from the Team's configured instance; do not retry unchanged input.`,
        1,
      );
    }
    if (error.statusCode === 404 && /GitLab connection/i.test(error.message)) {
      fail(
        "NO_GITLAB_CONNECTION",
        `${error.message} Ask a Team admin to configure the inbound webhook connection in Settings → Integrations → GitLab.`,
        1,
      );
    }
  }
  handleSdkError(error);
}
