import * as LabelPrimitive from "@radix-ui/react-label";
import { type ComponentPropsWithoutRef, forwardRef } from "react";
import { cn } from "../../lib/utils.js";

const Label = forwardRef<HTMLLabelElement, ComponentPropsWithoutRef<typeof LabelPrimitive.Root>>(
  ({ className, ...props }, ref) => (
    <LabelPrimitive.Root
      ref={ref}
      className={cn("text-label leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70", className)}
      {...props}
    />
  ),
);
Label.displayName = "Label";

export { Label };
