import { AlertTriangle, Bug, Sparkles, Wrench, Zap, type LucideIcon } from "lucide-react";
import { ColorChip } from "@/components/color-chip";
import { cn } from "@/lib/utils";
import {
  countReleaseItemsByKind,
  parseReleaseSections,
  splitReleaseItemScope,
  type ReleaseSection,
  type ReleaseSectionKind,
} from "@/lib/version/release-notes";

/** How each kind of change is drawn: its icon, count label, chip colours and list marker. */
const SECTION_STYLE: Record<
  ReleaseSectionKind,
  { icon: LucideIcon; label: [one: string, many: string]; chip: string; iconClass: string; dot: string }
> = {
  breaking: {
    icon: AlertTriangle,
    label: ["breaking change", "breaking changes"],
    chip: "border-red/25 bg-red-dim text-red",
    iconClass: "text-red",
    dot: "bg-red",
  },
  features: {
    icon: Sparkles,
    label: ["feature", "features"],
    chip: "border-green/25 bg-green-dim text-green",
    iconClass: "text-green",
    dot: "bg-green",
  },
  fixes: {
    icon: Bug,
    label: ["fix", "fixes"],
    chip: "border-sky/25 bg-sky-dim text-sky",
    iconClass: "text-sky",
    dot: "bg-sky",
  },
  performance: {
    icon: Zap,
    label: ["performance improvement", "performance improvements"],
    chip: "border-amber/25 bg-amber-dim text-amber",
    iconClass: "text-amber",
    dot: "bg-amber",
  },
  other: {
    icon: Wrench,
    label: ["other change", "other changes"],
    chip: "bg-muted/40 text-muted-foreground",
    iconClass: "text-muted-foreground",
    dot: "bg-muted-foreground/60",
  },
};

/** Release-please items start lowercase ("keep counts"); show them as sentences. */
function sentenceCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** One chip per kind of change with its item count ("3 features", "1 fix"). */
export function ReleaseKindCountChips({ sections }: { sections: ReleaseSection[] }) {
  return (
    <>
      {countReleaseItemsByKind(sections).map(({ kind, count }) => (
        <ColorChip key={kind} className={cn("tabular-nums", SECTION_STYLE[kind].chip)}>
          {count} {SECTION_STYLE[kind].label[count === 1 ? 0 : 1]}
        </ColorChip>
      ))}
    </>
  );
}

function ReleaseSectionList({ section }: { section: ReleaseSection }) {
  const style = SECTION_STYLE[section.kind];
  const Icon = style.icon;
  return (
    <div>
      <h4 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        <Icon className={cn("h-3.5 w-3.5", style.iconClass)} />
        {section.heading}
      </h4>
      <ul className="space-y-1.5">
        {section.items.map((item, i) => {
          const { scope, text } = splitReleaseItemScope(item);
          return (
            <li key={i} className="flex gap-2.5 text-sm leading-relaxed text-foreground/85">
              <span className={cn("mt-[0.55rem] h-1.5 w-1.5 shrink-0 rounded-full", style.dot)} />
              <span className="min-w-0">
                {scope && (
                  <ColorChip className="mr-1.5 py-px align-[1px] font-mono text-[11px]">{scope}</ColorChip>
                )}
                {sentenceCase(text)}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * A release-please body as headed lists — the one renderer the Settings →
 * System changelog and the "What's new" dialog share. Pass `sections` when the
 * caller has already parsed the body (the dialog counts them too).
 */
export function ReleaseNoteSections({
  body,
  sections,
  className,
}: {
  body?: string;
  sections?: ReleaseSection[];
  className?: string;
}) {
  const parsed = sections ?? parseReleaseSections(body ?? "");

  if (parsed.length === 0) {
    return <p className="text-sm italic text-muted-foreground">No release notes available.</p>;
  }

  return (
    <div className={cn("space-y-4", className)}>
      {parsed.map((section) => (
        <ReleaseSectionList key={section.heading} section={section} />
      ))}
    </div>
  );
}
