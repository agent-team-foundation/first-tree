import { ChevronDown, Play } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { Button } from "../ui/button.js";

export const ONBOARDING_ORIENTATION_CONTINUE_MESSAGE = "I'm ready. Please help me get started with First Tree.";

export const ONBOARDING_ORIENTATION_CHAPTERS = {
  "multi-agent": {
    id: "multi-agent",
    title: "Multi-agent collaboration",
    summary: "The right agents join as the work unfolds",
    durationInSeconds: 35,
    videoSrc: "/onboarding/orientation/multi-agent.mp4",
    posterSrc: "/onboarding/orientation/stills/multi-agent-poster.png",
    captionsSrc: "/onboarding/orientation/multi-agent.vtt",
    transcript:
      "Give one lead agent a clear software task. As the work unfolds, the lead @mentions UX, development, and QA agents in the same chat—each only when needed. Their working updates and replies stay in the shared conversation, and the verified pull request appears in the GitHub sidebar without the user coordinating separate chats.",
  },
} as const;

export type OnboardingOrientationChapterId = keyof typeof ONBOARDING_ORIENTATION_CHAPTERS;
export const ONBOARDING_ORIENTATION_DEFAULT_CHAPTER_ID: OnboardingOrientationChapterId = "multi-agent";

const CHAPTERS = Object.values(ONBOARDING_ORIENTATION_CHAPTERS);

export type OnboardingOrientationProps = {
  completed: boolean;
  continuing: boolean;
  onContinue: () => void | Promise<void>;
};

export function OnboardingOrientation({ completed, continuing, onContinue }: OnboardingOrientationProps) {
  const titleId = useId();
  const [expanded, setExpanded] = useState(!completed);
  const [selectedId, setSelectedId] = useState<OnboardingOrientationChapterId | null>(null);

  useEffect(() => {
    if (completed) setExpanded(false);
  }, [completed]);

  const selected = selectedId === null ? null : ONBOARDING_ORIENTATION_CHAPTERS[selectedId];

  if (!expanded) {
    return (
      <section
        aria-labelledby={titleId}
        data-onboarding-orientation="completed"
        className="mt-3 flex flex-col border border-border bg-muted/30 sm:flex-row sm:items-center"
        style={{ gap: "var(--sp-2)", padding: "var(--sp-2) var(--sp-3)", borderRadius: "var(--radius-input)" }}
      >
        <div className="flex min-w-0 flex-1 items-center" style={{ gap: "var(--sp-2)" }}>
          <span
            className="flex size-6 shrink-0 items-center justify-center rounded-full bg-secondary"
            aria-hidden="true"
          >
            <Play className="size-3.5" />
          </span>
          <div className="min-w-0 flex-1">
            <p id={titleId} className="text-label font-medium">
              First Tree introduction
            </p>
          </div>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="min-h-11 w-full sm:w-auto"
          onClick={() => setExpanded(true)}
        >
          Watch again
        </Button>
      </section>
    );
  }

  return (
    <section
      aria-labelledby={titleId}
      data-onboarding-orientation={completed ? "review" : "pending"}
      className="mt-3 overflow-hidden border border-border bg-background"
      style={{ borderRadius: "var(--radius-panel)" }}
    >
      <div className="flex flex-col" style={{ gap: "var(--sp-1)", padding: "var(--sp-4)" }}>
        <div className="flex flex-wrap items-start" style={{ gap: "var(--sp-2)" }}>
          <div className="min-w-0 flex-1">
            <p id={titleId} className="text-title font-semibold">
              {selected?.title ?? "See how First Tree works"}
            </p>
            <p className="text-body text-muted-foreground">
              {selected?.summary ?? "Watch a short product tour, or skip straight to work."}
            </p>
          </div>
          {selected ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="min-h-11 w-full sm:w-auto"
              onClick={() => setSelectedId(null)}
            >
              Choose another chapter
            </Button>
          ) : null}
        </div>
      </div>

      {selected ? (
        <div className="border-t border-border" style={{ padding: "var(--sp-4)" }}>
          <video
            key={selected.id}
            data-onboarding-orientation-video={selected.id}
            className="aspect-video w-full border border-border bg-muted/40"
            style={{ borderRadius: "var(--radius-input)" }}
            controls
            playsInline
            preload="metadata"
            poster={selected.posterSrc}
            aria-label={`${selected.title} orientation video`}
          >
            <source src={selected.videoSrc} type="video/mp4" />
            <track kind="captions" src={selected.captionsSrc} srcLang="en" label="English" default />
            {selected.transcript}
          </video>

          <details className="group mt-3 border-t border-border pt-3">
            <summary className="text-label inline-flex min-h-11 cursor-pointer items-center font-medium">
              Read transcript
              <ChevronDown className="ml-2 size-4 transition-transform group-open:rotate-180" aria-hidden="true" />
            </summary>
            <p className="text-body mt-2 text-muted-foreground">{selected.transcript}</p>
          </details>

          {!completed ? (
            <div className="mt-4 flex justify-end">
              <Button
                type="button"
                variant="cta"
                className="min-h-11"
                disabled={continuing}
                onClick={() => void onContinue()}
              >
                {continuing ? "Starting…" : "Start my first task"}
              </Button>
            </div>
          ) : null}
        </div>
      ) : (
        <>
          <div className="orientation-chapter-grid grid border-y border-border">
            {CHAPTERS.map((chapter, index) => (
              <button
                key={chapter.id}
                type="button"
                data-orientation-chapter={chapter.id}
                onClick={() => setSelectedId(chapter.id)}
                className="min-h-11 border-0 border-b border-border bg-transparent p-3 text-left outline-none transition-colors hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring sm:border-r"
              >
                <span className="flex items-start" style={{ gap: "var(--sp-2)" }}>
                  <span
                    className="mono text-caption flex size-6 shrink-0 items-center justify-center rounded-full bg-secondary"
                    aria-hidden="true"
                  >
                    {index + 1}
                  </span>
                  <span className="min-w-0">
                    <span className="text-label block font-medium">{chapter.title}</span>
                    <span className="text-caption hidden text-muted-foreground sm:block">{chapter.summary}</span>
                  </span>
                </span>
              </button>
            ))}
          </div>
          {!completed ? (
            <div className="flex justify-end" style={{ padding: "var(--sp-4)" }}>
              <Button
                type="button"
                variant="cta"
                className="min-h-11"
                disabled={continuing}
                onClick={() => void onContinue()}
              >
                {continuing ? "Starting…" : "Skip introduction and start"}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
