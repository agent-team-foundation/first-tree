import { forwardRef, type TextareaHTMLAttributes } from "react";
import { cn } from "../../lib/utils.js";

/**
 * Multi-line text input, the textarea sibling of `Input`. Shares the bordered
 * resting frame and the §13 focus treatment (border deepens to `--ring`, no
 * ring — one line, no double frame). Callers layer on sizing / resize / mono
 * via `className` (e.g. auto-growing prompt editors set `resize-none`).
 */
const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => {
    return (
      <textarea
        className={cn(
          "flex w-full rounded-[var(--radius-input)] border border-input bg-transparent px-3 py-2 text-body transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:border-ring disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        ref={ref}
        {...props}
      />
    );
  },
);
Textarea.displayName = "Textarea";

export { Textarea };
