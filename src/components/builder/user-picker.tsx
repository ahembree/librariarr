"use client";

import { useMemo, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/** The most usernames the picker renders at once; typing narrows the rest. */
export const USER_PICKER_LIMIT = 100;

/**
 * The usernames shown for `search`: those containing it (case-insensitive),
 * names starting with it first, then A–Z, at most `limit` of them, with how
 * many matched in all. Filtering here, not in cmdk, keeps a server with
 * thousands of users from rendering thousands of rows.
 */
export function filterUserOptions(
  options: readonly string[],
  search: string,
  limit = USER_PICKER_LIMIT,
): { shown: string[]; total: number } {
  const needle = search.trim().toLowerCase();
  const matches = needle ? options.filter((o) => o.toLowerCase().includes(needle)) : [...options];
  matches.sort((a, b) => {
    if (needle) {
      const aStarts = a.toLowerCase().startsWith(needle);
      const bStarts = b.toLowerCase().startsWith(needle);
      if (aStarts !== bStarts) return aStarts ? -1 : 1;
    }
    return a.localeCompare(b, undefined, { sensitivity: "base" });
  });
  return { shown: matches.slice(0, limit), total: matches.length };
}

/**
 * The users a per-user criterion offers: the listed users with a counted play,
 * plus the rule's own user when no listed name already stands for it
 * (matching is case-insensitive).
 */
export function perUserOptions(listed: readonly string[] | undefined, ruleUser: string): string[] {
  const names = [...new Set(listed ?? [])].filter((v) => typeof v === "string" && v.trim().length > 0);
  const own = ruleUser.trim();
  return own && !names.some((v) => v.toLowerCase() === own.toLowerCase()) ? [...names, own] : names;
}

/**
 * Searchable single-user picker for a per-user criterion (User Last Played).
 * `options` are the users with a counted play (the Watched By User values).
 */
export function UserPicker({
  value,
  options,
  onChange,
}: {
  value: string;
  options: readonly string[];
  onChange: (user: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const { shown, total } = useMemo(() => filterUserOptions(options, search), [options, search]);

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setSearch("");
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label="User"
          className="min-w-0 flex-[1_1_100%] sm:flex-none sm:w-36 justify-between font-normal"
        >
          <span className={`truncate ${value ? "" : "text-muted-foreground"}`}>{value || "Select user..."}</span>
          <ChevronDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 max-w-[90vw] p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput placeholder="Search users..." value={search} onValueChange={setSearch} />
          <CommandList className="max-h-72">
            <CommandEmpty>No users found.</CommandEmpty>
            {shown.length > 0 && (
              <CommandGroup>
                {shown.map((u) => (
                  <CommandItem
                    key={u}
                    value={u}
                    onSelect={() => {
                      onChange(u);
                      setOpen(false);
                      setSearch("");
                    }}
                  >
                    <span className="truncate">{u}</span>
                    {u.toLowerCase() === value.trim().toLowerCase() && <Check className="ml-auto h-3.5 w-3.5 shrink-0 text-primary" />}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
          {total > shown.length && (
            <p className="border-t px-3 py-2 text-xs text-muted-foreground">
              Showing {shown.length} of {total.toLocaleString("en-US")} — type to narrow
            </p>
          )}
        </Command>
      </PopoverContent>
    </Popover>
  );
}
