import { Check, Play, RotateCcw } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { flushSync } from "react-dom";
import orientationAuthoring from "../../../orientation-videos/chapters.json";
import { cn } from "../../lib/utils.js";
import { Button } from "../ui/button.js";

export const ONBOARDING_ORIENTATION_CONTINUE_MESSAGE = "I'm ready — let's get started.";

export function onboardingOrientationComposerPlaceholder(targetAgentName: string): string {
  return `Message ${targetAgentName} anything — or start with the tour above`;
}

export const ONBOARDING_ORIENTATION_CHAPTERS = {
  "multi-agent": {
    id: "multi-agent",
    title: "Multi-agent collaboration",
    summary: "The right agents join as the work unfolds",
    durationInSeconds: orientationAuthoring.chapters["multi-agent"].durationInSeconds,
    videoSrc: "/onboarding/orientation/multi-agent.mp4",
    posterSrc: "/onboarding/orientation/stills/multi-agent-poster.png",
    captionsSrc: "/onboarding/orientation/multi-agent.vtt",
  },
  "context-tree": {
    id: "context-tree",
    title: "Context Tree",
    summary: "Read, work, review, update—then start smarter",
    durationInSeconds: orientationAuthoring.chapters["context-tree"].durationInSeconds,
    videoSrc: "/onboarding/orientation/context-tree.mp4",
    posterSrc: "/onboarding/orientation/stills/context-tree-poster.png",
    captionsSrc: "/onboarding/orientation/context-tree.vtt",
  },
  github: {
    id: "github",
    title: "GitHub automation",
    summary: "Issue-to-PR work stays connected in one Chat",
    durationInSeconds: orientationAuthoring.chapters.github.durationInSeconds,
    videoSrc: "/onboarding/orientation/github.mp4",
    posterSrc: "/onboarding/orientation/stills/github-poster.png",
    captionsSrc: "/onboarding/orientation/github.vtt",
  },
} as const;

export type OnboardingOrientationChapterId = keyof typeof ONBOARDING_ORIENTATION_CHAPTERS;
export const ONBOARDING_ORIENTATION_DEFAULT_CHAPTER_ID: OnboardingOrientationChapterId = "multi-agent";

const CHAPTERS = Object.values(ONBOARDING_ORIENTATION_CHAPTERS);
const TOTAL_DURATION_IN_SECONDS = CHAPTERS.reduce((total, chapter) => total + chapter.durationInSeconds, 0);

function formatChapterDuration(durationInSeconds: number): string {
  const minutes = Math.floor(durationInSeconds / 60);
  const seconds = durationInSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function formatTotalDuration(durationInSeconds: number): string {
  const minutes = Math.floor(durationInSeconds / 60);
  const seconds = durationInSeconds % 60;
  if (minutes === 0) return `${seconds} sec`;
  if (seconds === 0) return `${minutes} min`;
  return `${minutes} min ${seconds} sec`;
}

export type OnboardingOrientationProps = {
  completed: boolean;
  continuing: boolean;
  targetAgentName: string | null;
  onContinue: () => void | Promise<void>;
};

export function OnboardingOrientation({
  completed,
  continuing,
  targetAgentName,
  onContinue,
}: OnboardingOrientationProps) {
  const titleId = useId();
  const videoRef = useRef<HTMLVideoElement>(null);
  const startFooterRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(!completed);
  const [selectedId, setSelectedId] = useState<OnboardingOrientationChapterId>(
    ONBOARDING_ORIENTATION_DEFAULT_CHAPTER_ID,
  );
  const [watchedIds, setWatchedIds] = useState<Set<OnboardingOrientationChapterId>>(() => new Set());
  const [videoError, setVideoError] = useState(false);
  const [playbackNeedsUserAction, setPlaybackNeedsUserAction] = useState(false);
  const normalizedTargetAgentName = targetAgentName?.trim() || null;
  const tourComplete = watchedIds.size === CHAPTERS.length;

  useEffect(() => {
    if (completed) setExpanded(false);
  }, [completed]);

  useEffect(() => {
    if (!tourComplete || completed) return;
    const prefersReducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    startFooterRef.current?.scrollIntoView?.({
      behavior: prefersReducedMotion ? "auto" : "smooth",
      block: "nearest",
    });
  }, [completed, tourComplete]);

  const selected = ONBOARDING_ORIENTATION_CHAPTERS[selectedId];

  const playSelectedChapter = (): void => {
    setPlaybackNeedsUserAction(false);
    try {
      const playPromise = videoRef.current?.play();
      if (playPromise) void playPromise.catch(() => setPlaybackNeedsUserAction(true));
    } catch {
      setPlaybackNeedsUserAction(true);
    }
  };

  const selectChapter = (chapterId: OnboardingOrientationChapterId): void => {
    // Mount the selected media synchronously so play() remains part of the
    // chapter button's user gesture, including on WebKit with audible media.
    flushSync(() => {
      setVideoError(false);
      setPlaybackNeedsUserAction(false);
      if (chapterId !== selectedId) setSelectedId(chapterId);
    });
    playSelectedChapter();
  };

  const markSelectedChapterWatched = (): void => {
    setWatchedIds((current) => {
      const next = new Set(current);
      next.add(selectedId);
      return next;
    });
  };

  if (!expanded) {
    const reviewLabel = watchedIds.size > 0 ? "Replay" : "Watch";
    return (
      <section
        aria-labelledby={titleId}
        data-onboarding-orientation="completed"
        className="mt-3 flex items-center border border-border bg-muted/30"
        style={{ gap: "var(--sp-2)", padding: "var(--sp-2) var(--sp-3)", borderRadius: "var(--radius-input)" }}
      >
        <div className="flex min-w-0 flex-1 items-center" style={{ gap: "var(--sp-2)" }}>
          <span
            className="flex size-7 shrink-0 items-center justify-center rounded-full bg-secondary"
            aria-hidden="true"
          >
            <Play className="size-3.5" />
          </span>
          <div className="min-w-0 flex-1">
            <p id={titleId} className="text-label font-medium">
              First Tree introduction
            </p>
            <p className="text-caption text-muted-foreground">
              Optional product tour · {formatTotalDuration(TOTAL_DURATION_IN_SECONDS)}
            </p>
          </div>
        </div>
        <Button type="button" variant="ghost" size="sm" className="min-h-11 shrink-0" onClick={() => setExpanded(true)}>
          {watchedIds.size > 0 ? <RotateCcw className="size-3.5" aria-hidden="true" /> : null}
          {reviewLabel}
        </Button>
      </section>
    );
  }

  return (
    <section
      aria-labelledby={titleId}
      data-onboarding-orientation={completed ? "review" : "pending"}
      className="mt-3 overflow-hidden border border-border bg-muted/20"
      style={{ borderRadius: "var(--radius-panel)" }}
    >
      <header className="flex flex-col" style={{ gap: "var(--sp-1)", padding: "var(--sp-4)" }}>
        <div className="flex flex-wrap items-center justify-between" style={{ gap: "var(--sp-2)" }}>
          <p id={titleId} className="text-title font-semibold text-balance">
            Get to know First Tree
          </p>
          <div className="flex shrink-0 items-center" style={{ gap: "var(--sp-2)" }}>
            <p className="mono text-caption text-muted-foreground">
              Optional · {formatTotalDuration(TOTAL_DURATION_IN_SECONDS)}
            </p>
            {!completed ? (
              <Button type="button" variant="ghost" size="sm" disabled={continuing} onClick={() => void onContinue()}>
                Skip intro
              </Button>
            ) : (
              <Button type="button" variant="ghost" size="sm" onClick={() => setExpanded(false)}>
                Close tour
              </Button>
            )}
          </div>
        </div>
        <p className="text-body max-w-[65ch] text-muted-foreground text-pretty">
          {completed
            ? "Replay any chapter, then close the tour when you’re done."
            : "Watch the short tours, or start whenever you’re ready."}
        </p>
      </header>

      <div className="border-t border-border bg-background" style={{ padding: "var(--sp-4)" }}>
        <div className="mb-3 flex items-start justify-between" style={{ gap: "var(--sp-3)" }}>
          <div className="min-w-0">
            <p className="text-label font-semibold text-pretty">{selected.title}</p>
            <p className="text-body mt-0.5 text-muted-foreground text-pretty">{selected.summary}</p>
          </div>
          <span className="mono text-caption shrink-0 text-muted-foreground">
            {formatChapterDuration(selected.durationInSeconds)}
          </span>
        </div>

        <div
          className={cn("overflow-hidden border border-border bg-muted/40", videoError ? "" : "relative aspect-video")}
          style={{ borderRadius: "var(--radius-input)" }}
        >
          <video
            key={selected.id}
            ref={videoRef}
            data-onboarding-orientation-video={selected.id}
            className={cn("size-full", videoError && "hidden")}
            controls
            playsInline
            preload="metadata"
            poster={selected.posterSrc}
            aria-label={`${selected.title} orientation video`}
            onPlay={() => setPlaybackNeedsUserAction(false)}
            onEnded={markSelectedChapterWatched}
            onError={() => setVideoError(true)}
          >
            <source src={selected.videoSrc} type="video/mp4" />
            <track kind="captions" src={selected.captionsSrc} srcLang="en" label="English captions" />
            Your browser does not support this video.
          </video>
          {videoError ? (
            <div
              data-onboarding-orientation-video-error
              className="flex flex-col bg-background text-left"
              style={{ gap: "var(--sp-3)", padding: "var(--sp-4)" }}
            >
              <div className="flex flex-wrap items-center justify-between" style={{ gap: "var(--sp-2)" }}>
                <div>
                  <p className="text-label font-medium" role="status">
                    This video couldn’t load
                  </p>
                  <p className="text-body mt-1 text-muted-foreground text-pretty">{selected.summary}</p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setVideoError(false);
                    videoRef.current?.load();
                  }}
                >
                  Try again
                </Button>
              </div>
            </div>
          ) : null}
        </div>

        {playbackNeedsUserAction && !videoError ? (
          <div
            data-onboarding-orientation-playback-prompt
            className="mt-2 flex flex-wrap items-center justify-between text-muted-foreground"
            style={{ gap: "var(--sp-2)" }}
            role="status"
          >
            <p className="text-body">Playback is ready. Press play to watch this chapter.</p>
            <Button type="button" variant="outline" size="sm" onClick={playSelectedChapter}>
              <Play className="size-3.5" aria-hidden="true" />
              Play chapter
            </Button>
          </div>
        ) : null}

        <nav className="mt-4" aria-label="Orientation chapters">
          <p className="text-label font-medium">Chapters</p>
          <ol className="mt-2 overflow-hidden border-y border-border">
            {CHAPTERS.map((chapter) => {
              const isSelected = chapter.id === selectedId;
              const isWatched = watchedIds.has(chapter.id);
              return (
                <li key={chapter.id} className="border-b border-border last:border-b-0">
                  <button
                    type="button"
                    data-orientation-chapter={chapter.id}
                    data-orientation-chapter-status={isWatched ? "watched" : isSelected ? "selected" : "unwatched"}
                    aria-current={isSelected ? "true" : undefined}
                    onClick={() => selectChapter(chapter.id)}
                    className={cn(
                      "group flex min-h-11 w-full items-center border-0 bg-transparent p-3 text-left outline-none transition-colors active:bg-muted focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
                      isSelected ? "bg-secondary/70 hover:bg-secondary" : "hover:bg-muted/60",
                    )}
                    style={{ gap: "var(--sp-3)" }}
                  >
                    <span
                      className={cn(
                        "flex size-7 shrink-0 items-center justify-center rounded-full transition-colors",
                        isSelected ? "bg-primary text-primary-foreground" : "bg-secondary text-secondary-foreground",
                      )}
                      aria-hidden="true"
                    >
                      {isWatched ? <Check className="size-3.5" /> : <Play className="size-3.5 translate-x-px" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="text-label block font-medium text-pretty">{chapter.title}</span>
                      <span className="text-caption hidden text-muted-foreground sm:block">{chapter.summary}</span>
                      {isWatched ? <span className="sr-only">Watched</span> : null}
                    </span>
                    <span className="mono text-caption shrink-0 text-muted-foreground">
                      {formatChapterDuration(chapter.durationInSeconds)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        </nav>

        {!completed ? (
          <div
            ref={startFooterRef}
            className="mt-4 flex flex-col border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between"
            style={{ gap: "var(--sp-3)" }}
          >
            <p className="text-caption text-muted-foreground" aria-live="polite">
              {tourComplete ? "Tour complete. Start whenever you’re ready." : "You can return to these videos anytime."}
            </p>
            <Button
              type="button"
              variant="cta"
              className="h-auto min-h-11 w-full max-w-full shrink-0 whitespace-normal break-words text-center sm:w-auto"
              style={{ overflowWrap: "anywhere" }}
              disabled={continuing}
              onClick={() => void onContinue()}
            >
              {continuing
                ? "Starting…"
                : normalizedTargetAgentName
                  ? `Start with ${normalizedTargetAgentName}`
                  : "Start"}
            </Button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
