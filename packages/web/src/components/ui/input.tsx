import { forwardRef, type InputHTMLAttributes } from "react";
import { cn } from "../../lib/utils.js";

const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          "flex h-9 w-full rounded-[var(--radius-input)] border border-input bg-transparent px-3 py-1 text-body transition-colors file:border-0 file:bg-transparent file:text-body file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:border-ring disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        ref={ref}
        {...props}
      />
    );
  },
);
Input.displayName = "Input";

export { Input };
