export type ScmAutoTopicVariant = {
  matches: string | RegExp;
  nextHead: string;
};

/** Provider-neutral topic rendering: provider adapters own only the compact head. */
export function formatScmAutoTopic(head: string, title: string | null | undefined): string {
  return title ? `${head}: ${title}` : head;
}

/**
 * Refresh only a recognised automatic topic. Each provider supplies its
 * accepted grammar and the canonical next head, so manual names remain sticky.
 */
export function refreshScmAutoTopic(
  storedTopic: string,
  title: string | null | undefined,
  variants: ScmAutoTopicVariant[],
): string | null {
  if (!title) return null;
  const matched = variants.find((variant) =>
    typeof variant.matches === "string"
      ? storedTopic === variant.matches || storedTopic.startsWith(`${variant.matches}: `)
      : variant.matches.test(storedTopic),
  );
  return matched ? formatScmAutoTopic(matched.nextHead, title) : null;
}

export type GitlabTopicEntity = {
  entityType: "issue" | "pull_request";
  entityIid: number;
  projectPath: string;
  title: string | null;
};

export type ContextReviewTopicEntity = {
  provider: "github" | "gitlab";
  repositoryPath: string;
  /** GitHub PR number or project-scoped GitLab MR IID. */
  changeNumber: number;
};

function repositorySegment(repositoryPath: string): string {
  return repositoryPath.split("/").filter(Boolean).at(-1) ?? repositoryPath;
}

/** Stable provider-neutral topic for one retained Context Reviewer chat. */
export function formatContextReviewTopic(entity: ContextReviewTopicEntity): string {
  const repository = repositorySegment(entity.repositoryPath);
  const referencePrefix = entity.provider === "github" ? "#" : "!";
  return `Context Review · ${repository}${referencePrefix}${entity.changeNumber}`;
}

export function formatGitlabEntityTopic(entity: GitlabTopicEntity, reviewFirstTouch = false): string {
  const project = repositorySegment(entity.projectPath);
  const head =
    entity.entityType === "pull_request"
      ? `${reviewFirstTouch ? "MR Review" : "MR"} ${project}!${entity.entityIid}`
      : `Issue ${project}#${entity.entityIid}`;
  return formatScmAutoTopic(head, entity.title);
}

export function refreshGitlabEntityTopic(storedTopic: string, entity: GitlabTopicEntity): string | null {
  const project = repositorySegment(entity.projectPath);
  const iid = String(entity.entityIid);
  if (entity.entityType === "pull_request") {
    return refreshScmAutoTopic(storedTopic, entity.title, [
      {
        matches: new RegExp(`^MR Review [^\\s/:]+!${iid}(?:: .*)?$`, "u"),
        nextHead: `MR Review ${project}!${entity.entityIid}`,
      },
      {
        matches: new RegExp(`^MR [^\\s/:]+!${iid}(?:: .*)?$`, "u"),
        nextHead: `MR ${project}!${entity.entityIid}`,
      },
    ]);
  }
  return refreshScmAutoTopic(storedTopic, entity.title, [
    {
      matches: new RegExp(`^Issue [^\\s/:]+#${iid}(?:: .*)?$`, "u"),
      nextHead: `Issue ${project}#${entity.entityIid}`,
    },
  ]);
}
