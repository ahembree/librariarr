import { avatarColor, avatarInitial } from "@/lib/avatar";
import { cn } from "@/lib/utils";

const SIZES = {
  sm: "h-5 w-5 text-[10px]",
  md: "h-7 w-7 text-xs",
  lg: "h-9 w-9 text-sm",
} as const;

/**
 * A user's initial in a circle coloured by their name. Decorative: the name
 * is always written beside it.
 */
export function UserAvatar({
  name,
  size = "md",
  className,
}: {
  name: string;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center justify-center rounded-full font-semibold shrink-0 ring-1",
        SIZES[size],
        avatarColor(name),
        className,
      )}
      aria-hidden
    >
      {avatarInitial(name)}
    </span>
  );
}
