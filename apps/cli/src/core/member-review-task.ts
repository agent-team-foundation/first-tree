import { readFile } from "node:fs/promises";
import {
  type ContextReviewTaskCreateMetadata,
  type CreateKeyedTaskChat,
  contextReviewTaskCreateMetadataSchema,
  type KeyedTaskChatCreateResponse,
} from "@first-tree/shared";
import { type MemberOrganizationProfile, resolveMemberOrganizationId } from "./member-org.js";

export type MemberReviewTaskClient = {
  getMemberProfile(): Promise<MemberOrganizationProfile>;
  createMemberKeyedTaskChat(organizationId: string, data: CreateKeyedTaskChat): Promise<KeyedTaskChatCreateResponse>;
};

export type MemberReviewTaskInputErrorCode =
  | "METADATA_FILE_READ_FAILED"
  | "INVALID_METADATA_FILE"
  | "INVALID_REVIEW_PACKET";

export class MemberReviewTaskInputError extends Error {
  constructor(
    readonly code: MemberReviewTaskInputErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MemberReviewTaskInputError";
  }
}

export async function readMemberReviewTaskMetadata(path: string): Promise<ContextReviewTaskCreateMetadata> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new MemberReviewTaskInputError("METADATA_FILE_READ_FAILED", `Could not read --metadata-file: ${message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new MemberReviewTaskInputError("INVALID_METADATA_FILE", "--metadata-file must contain valid JSON");
  }
  const metadata = contextReviewTaskCreateMetadataSchema.safeParse(parsed);
  if (!metadata.success) {
    const issue = metadata.error.issues[0];
    const pathLabel = issue?.path.length ? `${issue.path.join(".")}: ` : "";
    throw new MemberReviewTaskInputError(
      "INVALID_REVIEW_PACKET",
      `${pathLabel}${issue?.message ?? "Invalid Agent Review metadata"}`,
    );
  }
  return metadata.data;
}

export async function dispatchMemberReviewTask(
  sdk: MemberReviewTaskClient,
  input: { opening: string; metadataFile: string; organizationId?: string },
): Promise<KeyedTaskChatCreateResponse> {
  const [profile, metadata] = await Promise.all([
    sdk.getMemberProfile(),
    readMemberReviewTaskMetadata(input.metadataFile),
  ]);
  const organizationId = resolveMemberOrganizationId(profile, input.organizationId);
  return sdk.createMemberKeyedTaskChat(organizationId, {
    mode: "keyed_task",
    initialMessage: { format: "markdown", content: input.opening, metadata },
  });
}
