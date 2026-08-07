import { type FormEvent, type KeyboardEvent, type ReactNode, useState } from "react";
import {
  ONBOARDING_ORIENTATION_CONTINUE_MESSAGE,
  OnboardingOrientation,
  onboardingOrientationComposerPlaceholder,
} from "../components/chat/onboarding-orientation.js";
import { Button } from "../components/ui/button.js";

/** DEV-only visual review surface for the real inline first-chat Orientation. */

type Variant = "attributed" | "senderless";

function MessageRow({ name, initial, children }: { name: string; initial: string; children: ReactNode }) {
  return (
    <div className="grid" style={{ gridTemplateColumns: "var(--sp-5) 1fr", gap: "var(--sp-2)" }}>
      <span
        aria-hidden="true"
        className="flex size-5 items-center justify-center rounded-full bg-secondary text-caption font-semibold"
      >
        {initial}
      </span>
      <div className="min-w-0">
        <p className="mono text-body font-semibold">{name}</p>
        <div className="text-body mt-1">{children}</div>
      </div>
    </div>
  );
}

function ContinuationRows({ humanMessage }: { humanMessage: string }) {
  return (
    <>
      <MessageRow name="Gandy" initial="G">
        <p>{humanMessage}</p>
      </MessageRow>
      <MessageRow name="Nova" initial="N">
        <p className="text-muted-foreground">
          The agent wakes from this first visible message, with the stored bootstrap as preceding context.
        </p>
      </MessageRow>
    </>
  );
}

/** Comparison baseline: the bootstrap is a user-attributed message row. */
function AttributedVariant({
  completed,
  humanMessage,
  onContinue,
}: {
  completed: boolean;
  humanMessage: string;
  onContinue: () => void;
}) {
  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-4)" }}>
      <MessageRow name="Gandy" initial="G">
        <p>
          Nova, welcome aboard.
          <br />
          <br />
          Please help me get started with First Tree.
        </p>
        <OnboardingOrientation
          key={completed ? "completed" : "pending"}
          completed={completed}
          continuing={false}
          targetAgentName="Nova"
          onContinue={onContinue}
        />
      </MessageRow>
      {completed ? <ContinuationRows humanMessage={humanMessage} /> : null}
    </div>
  );
}

/**
 * Proposed rendering: the bootstrap body and sender attribution are not shown.
 * The Orientation is a sender-less full-width card; the member's continuation
 * is the first attributed message in the timeline.
 */
function SenderlessVariant({
  completed,
  humanMessage,
  onContinue,
}: {
  completed: boolean;
  humanMessage: string;
  onContinue: () => void;
}) {
  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-4)" }}>
      <div className="[&>section]:mt-0">
        <OnboardingOrientation
          key={completed ? "completed" : "pending"}
          completed={completed}
          continuing={false}
          targetAgentName="Nova"
          onContinue={onContinue}
        />
      </div>
      {completed ? <ContinuationRows humanMessage={humanMessage} /> : null}
    </div>
  );
}

function ComposerPreview({
  orientationPending,
  draft,
  onDraftChange,
  onSend,
}: {
  orientationPending: boolean;
  draft: string;
  onDraftChange: (draft: string) => void;
  onSend: () => void;
}) {
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    onSend();
  };

  const sendOnEnter = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    onSend();
  };

  return (
    <form className="shrink-0 border-t border-border bg-background" onSubmit={submit}>
      <div
        className="composer-card m-3 flex items-end border border-border bg-background sm:m-4"
        style={{ gap: "var(--sp-2)" }}
      >
        <textarea
          aria-label="Message composer preview"
          className="text-subtitle min-h-14 min-w-0 flex-1 resize-none border-0 bg-transparent p-3 font-normal text-foreground outline-none"
          placeholder={
            orientationPending
              ? onboardingOrientationComposerPlaceholder("Nova")
              : "Message @Nova  ·  / for commands  ·  @ to mention"
          }
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={sendOnEnter}
          rows={2}
        />
        <Button type="submit" className="m-2 shrink-0" disabled={!draft.trim()}>
          Send
        </Button>
      </div>
    </form>
  );
}

export function OnboardingOrientationPreviewPage() {
  const [variant, setVariant] = useState<Variant>("senderless");
  const [completed, setCompleted] = useState(false);
  const [draft, setDraft] = useState("");
  const [humanMessage, setHumanMessage] = useState(ONBOARDING_ORIENTATION_CONTINUE_MESSAGE);

  const completeWith = (message: string): void => {
    setHumanMessage(message);
    setCompleted(true);
  };

  const sendDraft = (): void => {
    const message = draft.trim();
    if (!message) return;
    completeWith(message);
    setDraft("");
  };

  return (
    <main className="h-dvh-screen overflow-hidden bg-background p-4 sm:p-8">
      <div className="mx-auto flex h-full min-h-0 max-w-3xl flex-col">
        <header className="mb-6 flex shrink-0 flex-wrap items-end justify-between" style={{ gap: "var(--sp-3)" }}>
          <div>
            <p className="mono text-caption text-muted-foreground">DEV PREVIEW · REAL COMPONENT</p>
            <h1 className="text-title font-semibold">First-chat Orientation</h1>
            <p className="text-body text-muted-foreground">
              Compare row ownership, then type in the live composer to exercise the direct-message path.
            </p>
          </div>
          <div className="flex flex-wrap" style={{ gap: "var(--sp-2)" }}>
            <div className="flex" style={{ gap: "var(--sp-2)" }}>
              <Button
                type="button"
                variant={variant === "attributed" ? "default" : "outline"}
                onClick={() => setVariant("attributed")}
              >
                Attributed row
              </Button>
              <Button
                type="button"
                variant={variant === "senderless" ? "default" : "outline"}
                onClick={() => setVariant("senderless")}
              >
                Senderless row
              </Button>
            </div>
            <div className="flex" style={{ gap: "var(--sp-2)" }}>
              <Button type="button" variant={!completed ? "default" : "outline"} onClick={() => setCompleted(false)}>
                Pending
              </Button>
              <Button
                type="button"
                variant={completed ? "default" : "outline"}
                onClick={() => completeWith(ONBOARDING_ORIENTATION_CONTINUE_MESSAGE)}
              >
                Completed
              </Button>
            </div>
          </div>
        </header>

        <section
          aria-label="First chat preview"
          className="flex min-h-0 flex-1 flex-col overflow-hidden border-y border-border"
        >
          <div
            className="min-h-0 flex-1 overflow-y-auto py-4"
            data-onboarding-orientation-preview-timeline
            style={{ paddingInline: "var(--sp-1)" }}
          >
            {variant === "attributed" ? (
              <AttributedVariant
                completed={completed}
                humanMessage={humanMessage}
                onContinue={() => completeWith(ONBOARDING_ORIENTATION_CONTINUE_MESSAGE)}
              />
            ) : (
              <SenderlessVariant
                completed={completed}
                humanMessage={humanMessage}
                onContinue={() => completeWith(ONBOARDING_ORIENTATION_CONTINUE_MESSAGE)}
              />
            )}
          </div>
          <ComposerPreview orientationPending={!completed} draft={draft} onDraftChange={setDraft} onSend={sendDraft} />
        </section>
      </div>
    </main>
  );
}
