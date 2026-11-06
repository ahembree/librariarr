"use client";

import { Check, ChevronsUpDown, X } from "lucide-react";
import { ColorChip } from "@/components/color-chip";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";

interface ArrTagPickerProps {
  mode: "add" | "remove";
  /** Tags known to the Arr instances, offered in the dropdown. */
  options: string[];
  selected: string[];
  onChange: (tags: string[]) => void;
}

/**
 * Multi-select of Arr tag labels for one tag operation (add or remove). The
 * rule editor renders one per operation so a rule set can add some tags and
 * remove others in the same action.
 */
export function ArrTagPicker({ mode, options, selected, onChange }: ArrTagPickerProps) {
  const isAdd = mode === "add";
  const toggle = (tag: string) =>
    onChange(selected.includes(tag) ? selected.filter((t) => t !== tag) : [...selected, tag]);
  const id = `arr-tags-${mode}`;

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{isAdd ? "Add Tags" : "Remove Tags"}</Label>
      <Popover>
        <PopoverTrigger asChild>
          <Button id={id} variant="outline" role="combobox" className="w-full justify-between font-normal">
            <span className="truncate text-muted-foreground">
              {selected.length === 0
                ? isAdd ? "Select tags to add..." : "Select tags to remove..."
                : `${selected.length} tag${selected.length === 1 ? "" : "s"} selected`}
            </span>
            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-(--radix-popover-trigger-width) p-0" align="start">
          <Command>
            <CommandInput placeholder="Search or type new tag..." />
            <CommandList>
              <CommandEmpty>
                <button
                  className="w-full text-left px-2 py-1.5 text-sm hover:bg-accent rounded-sm"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    const input = (e.currentTarget.closest("[cmdk-root]")?.querySelector("[cmdk-input]") as HTMLInputElement)?.value?.trim();
                    if (!input || selected.includes(input)) return;
                    onChange([...selected, input]);
                  }}
                >
                  Add New Tag
                </button>
              </CommandEmpty>
              <CommandGroup>
                {options.map((tag) => {
                  const isSelected = selected.includes(tag);
                  return (
                    <CommandItem key={tag} value={tag} onSelect={() => toggle(tag)}>
                      <Check className={`mr-2 h-4 w-4 ${isSelected ? "opacity-100" : "opacity-0"}`} />
                      {tag}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selected.map((tag) => (
            <ColorChip
              key={tag}
              className={`gap-1 ${isAdd ? "border-green/30 bg-green-dim text-green" : "border-red/30 bg-red-dim text-red"}`}
            >
              {isAdd ? "+" : "-"}{tag}
              <button
                type="button"
                aria-label={`Remove ${tag}`}
                onClick={() => onChange(selected.filter((t) => t !== tag))}
                className={isAdd ? "hover:text-green" : "hover:text-red"}
              >
                <X className="h-3 w-3" />
              </button>
            </ColorChip>
          ))}
        </div>
      )}
    </div>
  );
}
