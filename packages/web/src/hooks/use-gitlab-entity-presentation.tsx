import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import type { Components } from "react-markdown";
import { gitlabConnectionsQueryKey, listGitlabConnectionsAt } from "../api/gitlab-connections.js";
import { gitlabEntityLinkPresentation } from "../lib/gitlab-entity-link.js";
import { isNavigableWebHref } from "../lib/safe-href.js";

const GITLAB_CONNECTION_REFRESH_MS = 30_000;

/**
 * Resolve GitLab link presentation against the rendered chat's Team. Both
 * workspace and Mobile Now use this hook so their blocking-request surfaces
 * share the same trust boundary and bounded connection refresh.
 */
export function useGitlabEntityPresentation(organizationId: string | null): {
  instanceOrigin: string | null;
  markdownComponents: Components;
} {
  const connections = useQuery({
    queryKey: gitlabConnectionsQueryKey(organizationId),
    queryFn: () => (organizationId ? listGitlabConnectionsAt(organizationId) : Promise.resolve([])),
    enabled: !!organizationId,
    staleTime: GITLAB_CONNECTION_REFRESH_MS,
    refetchInterval: GITLAB_CONNECTION_REFRESH_MS,
  });
  const instanceOrigin = connections.data?.[0]?.instanceOrigin ?? null;
  const markdownComponents = useMemo<Components>(
    () => ({
      a: ({ node, href, children, ...props }) => {
        void node;
        if (!isNavigableWebHref(href)) return <>{children}</>;
        const presentation =
          typeof children === "string" && children === href ? gitlabEntityLinkPresentation(href, instanceOrigin) : null;
        return (
          <a
            {...props}
            href={href}
            title={presentation?.title ?? props.title}
            target="_blank"
            rel="noopener noreferrer"
          >
            {presentation?.label ?? children}
          </a>
        );
      },
    }),
    [instanceOrigin],
  );

  return { instanceOrigin, markdownComponents };
}
