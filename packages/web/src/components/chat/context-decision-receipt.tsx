import {
  type ContextDecision,
  type ContextDecisionEffect,
  type ContextDecisionEvidence,
  canonicalGitRepoIdentity,
  resolveGitLabRepositoryWebIdentity,
} from "@first-tree/shared";
import { ChevronDown, ChevronUp, ExternalLink } from "lucide-react";
import { useId, useState } from "react";
import { FirstTreeLogo } from "../first-tree-logo.js";

/**
 * How the four receipt effects read to a person. The label answers "what did
 * shared team context DO here" in the user's language; the raw enum never
 * reaches the screen. `confirmed` deliberately avoids "verified"/"correct" and
 * carries no success check — Tree content supported the direction, it did not
 * prove the result right.
 */
const EFFECT_LABELS: Record<ContextDecisionEffect, string> = {
  conflicted: "Conflict surfaced",
  redirected: "Approach changed",
  constrained: "Options narrowed",
  confirmed: "Direction supported",
};

/**
 * Agent-reported proof that the team's Context Tree shaped THIS answer.
 *
 * Placement is the whole point: it sits directly under the result being judged
 * (an agent's chat reply, or an ask's question body above the answer controls),
 * so the reader sees what team context changed at the moment they decide
 * whether to trust the result.
 *
 * Trust contract — the module states the outcome objectively ("Options
 * narrowed") because that is what the agent reports, but it is NOT a First Tree
 * verification:
 *   - the visual is a scoped Context Tree panel, never system/verified card
 *     chrome, and carries no success check or "verified" copy;
 *   - the collapsed state stays on user value; the agent-attribution sentence
 *     lives at the bottom of the expanded sources, where a reader who is
 *     inspecting provenance actually needs it. That weakening is only valid
 *     while the receipt is still attached to its authoring agent's message —
 *     any future cross-message digest must re-state attribution up front.
 *
 * Rendering is gated on a strict parse upstream (`readContextDecisionMetadata`),
 * so a partial or unknown-version payload shows nothing at all rather than a
 * half-claim.
 */
export function ContextDecisionReceipt({
  receipt,
  gitlabInstanceOrigin = null,
}: {
  receipt: ContextDecision;
  /**
   * The Team's GitLab web origin, when connected. Used only to turn a GitLab
   * source into an exact-commit link; without a confident match the source
   * stays plain text rather than becoming a guessed (possibly dead) URL.
   */
  gitlabInstanceOrigin?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const conflict = receipt.effect === "conflicted";

  return (
    <aside
      aria-label="Context Tree influence reported by the agent"
      className="text-body"
      style={{
        marginTop: "var(--sp-3)",
        padding: "var(--sp-3)",
        borderRadius: "var(--radius-panel)",
        background: "var(--brand-bg)",
      }}
    >
      <div className="flex items-start" style={{ gap: "var(--sp-2_5)" }}>
        <FirstTreeLogo
          width={14}
          height={16}
          style={{ marginTop: "var(--sp-1)", flexShrink: 0, color: "var(--brand)" }}
        />
        <div className="min-w-0 flex-1">
          <div className="text-eyebrow uppercase" style={{ color: "var(--brand-dim)" }}>
            Context Tree in action
          </div>
          <div
            className="font-semibold"
            style={{
              marginTop: "var(--sp-0_5)",
              color: conflict ? "var(--warning)" : "var(--fg)",
            }}
          >
            {EFFECT_LABELS[receipt.effect]}
          </div>
          <p className="leading-relaxed" style={{ marginTop: "var(--sp-1)", color: "var(--fg-2)" }}>
            {receipt.summary}
          </p>
          <button
            type="button"
            aria-expanded={open}
            aria-controls={detailsId}
            onClick={() => setOpen((value) => !value)}
            className="text-caption font-medium flex w-full items-center text-left"
            style={{
              marginTop: "var(--sp-1_5)",
              minHeight: "var(--sp-11)",
              gap: "var(--sp-2)",
              color: "var(--fg-3)",
            }}
          >
            <span className="min-w-0 flex-1">
              {receipt.evidence.length === 1 ? "1 team decision" : `${receipt.evidence.length} team decisions`}
            </span>
            {open ? (
              <ChevronUp aria-hidden className="size-3.5 shrink-0" />
            ) : (
              <ChevronDown aria-hidden className="size-3.5 shrink-0" />
            )}
          </button>
          {open ? (
            <div id={detailsId}>
              <div className="text-label font-semibold" style={{ color: "var(--fg)" }}>
                Team decisions applied to this result
              </div>
              <ul
                className="flex flex-col"
                style={{ listStyle: "none", margin: "var(--sp-2) 0 0", padding: 0, gap: "var(--sp-2)" }}
              >
                {receipt.evidence.map((evidence) => (
                  <li key={`${evidence.repoUrl}@${evidence.commit}:${evidence.nodePath}`}>
                    <EvidenceRow evidence={evidence} gitlabInstanceOrigin={gitlabInstanceOrigin} />
                  </li>
                ))}
              </ul>
              <p
                className="text-caption leading-relaxed"
                style={{
                  marginTop: "var(--sp-3)",
                  paddingTop: "var(--sp-2_5)",
                  borderTop: "var(--hairline) solid var(--border-faint)",
                  color: "var(--fg-3)",
                }}
              >
                Added by the agent. First Tree preserves the cited version for inspection, but does not independently
                verify causality.
              </p>
            </div>
          ) : null}
        </div>
      </div>
    </aside>
  );
}

/**
 * One cited node: the human-readable heading first, then the exact source it
 * came from. The repository shows as its `namespace/repo` identity and the
 * commit as a short prefix — a full URL or 40-char SHA is noise at this size,
 * and the link (when the forge is unambiguous) already carries the exact one.
 */
function EvidenceRow({
  evidence,
  gitlabInstanceOrigin,
}: {
  evidence: ContextDecisionEvidence;
  gitlabInstanceOrigin: string | null;
}) {
  const identity = canonicalGitRepoIdentity(evidence.repoUrl);
  const href = contextDecisionSourceHref(evidence, gitlabInstanceOrigin);
  const title = evidence.heading ?? nodeFileName(evidence.nodePath);
  const provenance = `${identity?.path ?? evidence.repoUrl} · ${evidence.commit.slice(0, 7)}`;

  const body = (
    <>
      <span className="text-label font-medium block truncate" style={{ color: "var(--fg)" }}>
        {title}
      </span>
      <span className="mono text-caption block truncate" style={{ color: "var(--fg-2)" }}>
        {evidence.nodePath}
      </span>
      <span className="text-caption block truncate" style={{ color: "var(--fg-3)" }}>
        {provenance}
      </span>
    </>
  );

  if (!href) {
    return (
      <div className="min-w-0" style={{ minHeight: "var(--sp-11)" }} title={evidence.nodePath}>
        {body}
      </div>
    );
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="flex min-w-0 items-start no-underline"
      style={{ minHeight: "var(--sp-11)", gap: "var(--sp-2)", color: "inherit" }}
      title={`${evidence.nodePath} at ${evidence.commit.slice(0, 7)}`}
    >
      <span className="min-w-0 flex-1">{body}</span>
      <ExternalLink aria-hidden className="size-3.5 shrink-0" style={{ color: "var(--fg-3)" }} />
    </a>
  );
}

/**
 * Exact-commit file link, or `null` when the forge cannot be identified with
 * confidence. GitHub is recognized by host; a non-GitHub host only links when
 * it matches the Team's connected GitLab origin. Everything else stays plain
 * text — a broken link would undermine the one thing this module can promise:
 * the cited source is inspectable.
 */
export function contextDecisionSourceHref(
  evidence: ContextDecisionEvidence,
  gitlabInstanceOrigin: string | null,
): string | null {
  const identity = canonicalGitRepoIdentity(evidence.repoUrl);
  if (!identity) return null;
  const path = evidence.nodePath.split("/").map(encodeURIComponent).join("/");
  if (identity.host === "github.com") {
    return `https://github.com/${identity.path}/blob/${evidence.commit}/${path}`;
  }
  const gitlab = resolveGitLabRepositoryWebIdentity(evidence.repoUrl, gitlabInstanceOrigin);
  if (gitlab?.originMatchesConnection) {
    return `${gitlab.origin}/${gitlab.path}/-/blob/${evidence.commit}/${path}`;
  }
  return null;
}

function nodeFileName(nodePath: string): string {
  return nodePath.split("/").filter(Boolean).at(-1) ?? nodePath;
}
