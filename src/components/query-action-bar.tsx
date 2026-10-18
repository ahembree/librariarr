"use client";

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Loader2, Play, X, Tag, ChevronDown } from "lucide-react";
import {
  MOVIE_ACTION_TYPES,
  SERIES_ACTION_TYPES,
  MUSIC_ACTION_TYPES,
  QUALITY_PROFILE_ACTION_TYPES,
  supportsSearchAfter as canSearchAfter,
  deletesArrRecord,
} from "@/lib/lifecycle/action-types";
import { formatBytesNum } from "@/lib/format";
import { MAX_QUERY_ACTION_ITEMS } from "@/lib/query/constants";

export type ArrFamily = "radarr" | "sonarr" | "lidarr";
type MediaType = "MOVIE" | "SERIES" | "MUSIC";

export interface ArrFamilyMeta {
  qualityProfiles: Array<{ id: number; name: string }>;
  tags: string[];
}

export interface QueryActionConfig {
  actionType: string;
  /** The media type acted on. "Do Nothing" (tags only) carries no Arr suffix,
   *  so its family comes from here rather than from the action type. */
  mediaType: MediaType;
  arrInstanceId: string;
  targetQualityProfileId: number | null;
  addImportExclusion: boolean;
  searchAfterAction: boolean;
  addArrTags: string[];
  removeArrTags: string[];
}

interface QueryActionBarProps {
  selectedCount: number;
  /** Total file size (bytes) of the selected items. */
  selectedSize: number;
  /** Count of selected items per media type. */
  selectionTypeCounts: Record<MediaType, number>;
  /** Arr instance chosen on the page per family (id). */
  arrServerIds: { radarr?: string; sonarr?: string; lidarr?: string };
  /** Per-family metadata for the chosen instance (quality profiles + tags). */
  arrMeta: Record<ArrFamily, ArrFamilyMeta>;
  executing: boolean;
  onExecute: (config: QueryActionConfig) => void;
  onClear: () => void;
}

const FAMILY_BY_TYPE: Record<MediaType, ArrFamily> = {
  MOVIE: "radarr",
  SERIES: "sonarr",
  MUSIC: "lidarr",
};

const ACTIONS_BY_FAMILY: Record<ArrFamily, { value: string; label: string }[]> = {
  radarr: MOVIE_ACTION_TYPES,
  sonarr: SERIES_ACTION_TYPES,
  lidarr: MUSIC_ACTION_TYPES,
};

const FAMILY_LABEL: Record<ArrFamily, string> = {
  radarr: "Movies",
  sonarr: "Series",
  lidarr: "Music",
};

/** "Do Nothing" is one action type shared by every family, so the dropdown
 *  gives each family its own value (`DO_NOTHING:radarr`, …) and submits plain
 *  `DO_NOTHING` with that family's instance. */
const TAG_ONLY_PREFIX = "DO_NOTHING:";

function familyFromActionType(actionType: string): ArrFamily | null {
  if (actionType.startsWith(TAG_ONLY_PREFIX)) {
    const fam = actionType.slice(TAG_ONLY_PREFIX.length);
    return fam === "radarr" || fam === "sonarr" || fam === "lidarr" ? fam : null;
  }
  if (actionType.endsWith("RADARR")) return "radarr";
  if (actionType.endsWith("SONARR")) return "sonarr";
  if (actionType.endsWith("LIDARR")) return "lidarr";
  return null;
}

/** Multi-select tag picker (free input + known tags), mirrors the page's server picker. */
function TagPicker({
  label,
  options,
  selected,
  onChange,
  disabled,
}: {
  label: string;
  options: string[];
  selected: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
}) {
  const toggle = (tag: string) =>
    onChange(selected.includes(tag) ? selected.filter((t) => t !== tag) : [...selected, tag]);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 gap-1.5" disabled={disabled}>
          <Tag className="h-3.5 w-3.5" />
          {label}
          {selected.length > 0 && <span className="text-xs text-muted-foreground">({selected.length})</span>}
          <ChevronDown className="h-3.5 w-3.5 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-0" align="start">
        <Command>
          <CommandInput
            placeholder="Add tag…"
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                const input = (e.target as HTMLInputElement).value.trim();
                if (input && !selected.includes(input)) {
                  onChange([...selected, input]);
                  (e.target as HTMLInputElement).value = "";
                }
              }
            }}
          />
          <CommandList>
            <CommandEmpty>Press Enter to add a new tag</CommandEmpty>
            <CommandGroup>
              {options.map((tag) => (
                <CommandItem key={tag} value={tag} onSelect={() => toggle(tag)}>
                  <Checkbox checked={selected.includes(tag)} className="mr-2" />
                  {tag}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export function QueryActionBar({
  selectedCount,
  selectedSize,
  selectionTypeCounts,
  arrServerIds,
  arrMeta,
  executing,
  onExecute,
  onClear,
}: QueryActionBarProps) {
  const [actionType, setActionType] = useState<string>("");
  const [targetQualityProfileId, setTargetQualityProfileId] = useState<number | null>(null);
  const [addArrTags, setAddArrTags] = useState<string[]>([]);
  const [removeArrTags, setRemoveArrTags] = useState<string[]>([]);
  const [addImportExclusion, setAddImportExclusion] = useState(false);
  const [searchAfterAction, setSearchAfterAction] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  // Families that have selected items AND an Arr instance configured on the page.
  const actionableFamilies = useMemo(() => {
    return (Object.keys(FAMILY_BY_TYPE) as MediaType[])
      .filter((t) => selectionTypeCounts[t] > 0)
      .map((t) => FAMILY_BY_TYPE[t])
      .filter((fam) => Boolean(arrServerIds[fam]));
  }, [selectionTypeCounts, arrServerIds]);

  // The bar stays mounted across selection changes, so a previously-chosen
  // action can become invalid when its Arr family leaves the selection. Derive
  // the effective action (treating an orphaned one as unset) instead of writing
  // state from an effect — the dropdown then never shows a value absent from
  // its current options.
  const rawFamily = familyFromActionType(actionType);
  const familyActive = rawFamily ? actionableFamilies.includes(rawFamily) : false;
  const family = familyActive ? rawFamily : null;
  const effectiveActionType = familyActive ? actionType : "";
  // What the server is sent: the per-family "Do Nothing" value is plain DO_NOTHING.
  const submittedActionType = effectiveActionType.startsWith(TAG_ONLY_PREFIX) ? "DO_NOTHING" : effectiveActionType;

  const arrInstanceId = family ? arrServerIds[family] : undefined;
  const meta = family ? arrMeta[family] : undefined;
  const needsProfile = QUALITY_PROFILE_ACTION_TYPES.has(submittedActionType);
  const supportsImportExclusion = submittedActionType.includes("DELETE");
  const supportsSearchAfter = canSearchAfter(submittedActionType);
  const isTagOnly = submittedActionType === "DO_NOTHING";
  // Deleting the whole Arr record deletes its tags with it; every other
  // action — the file-only deletes included — keeps the record, so tags apply.
  const supportsTags = !!family && !deletesArrRecord(submittedActionType);
  const hasTags = supportsTags && (addArrTags.length > 0 || removeArrTags.length > 0);

  const targetCount = family
    ? selectionTypeCounts[(Object.keys(FAMILY_BY_TYPE) as MediaType[]).find((t) => FAMILY_BY_TYPE[t] === family)!]
    : 0;
  const skippedCount = selectedCount - targetCount;

  const noSelection = selectedCount === 0;
  // The server caps each request at MAX_QUERY_ACTION_ITEMS ids, so a larger
  // selection is sent as several sequential requests (chunked client-side).
  // Count against the action's own family (`targetCount`) — only those items are
  // sent — so a mixed selection isn't over-batched. Before an action is picked
  // the family is unknown, so fall back to the whole selection as a rough hint.
  const batchBasis = family ? targetCount : selectedCount;
  const batchCount = Math.ceil(batchBasis / MAX_QUERY_ACTION_ITEMS);
  const willBatch = batchCount > 1;

  const canRun =
    !noSelection &&
    !!effectiveActionType &&
    !!arrInstanceId &&
    targetCount > 0 &&
    !executing &&
    (!needsProfile || targetQualityProfileId != null) &&
    (!isTagOnly || hasTags);

  const resetAction = () => {
    setActionType("");
    setTargetQualityProfileId(null);
    setAddArrTags([]);
    setRemoveArrTags([]);
    setAddImportExclusion(false);
    setSearchAfterAction(false);
  };

  const handleConfirm = () => {
    if (!effectiveActionType || !arrInstanceId) return;
    if (!family) return;
    onExecute({
      actionType: submittedActionType,
      mediaType: (Object.keys(FAMILY_BY_TYPE) as MediaType[]).find((t) => FAMILY_BY_TYPE[t] === family)!,
      arrInstanceId,
      targetQualityProfileId: needsProfile ? targetQualityProfileId : null,
      // Only submit toggles the current action actually exposes — a checkbox
      // ticked under a previous action type must not leak into this run.
      addImportExclusion: supportsImportExclusion && addImportExclusion,
      searchAfterAction: supportsSearchAfter && searchAfterAction,
      addArrTags: supportsTags ? addArrTags : [],
      removeArrTags: supportsTags ? removeArrTags : [],
    });
    setConfirmOpen(false);
    resetAction();
  };

  const actionLabel = useMemo(() => {
    if (!family) return effectiveActionType;
    return ACTIONS_BY_FAMILY[family].find((a) => a.value === submittedActionType)?.label ?? effectiveActionType;
  }, [family, effectiveActionType, submittedActionType]);

  const noFamilies = actionableFamilies.length === 0;
  const controlsDisabled = noSelection || noFamilies;

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-card px-3 py-2">
      <span className="text-sm font-medium">
        {noSelection ? (
          "Actions"
        ) : (
          <>
            {selectedCount.toLocaleString()} selected
            {selectedSize > 0 ? ` · ${formatBytesNum(selectedSize)}` : ""}
            {willBatch && (
              <span className="ml-1 font-normal text-muted-foreground">
                · {batchCount} batches
              </span>
            )}
          </>
        )}
      </span>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 px-2 text-muted-foreground"
        onClick={onClear}
        disabled={noSelection}
      >
        <X className="h-3.5 w-3.5" />
        Clear
      </Button>

      <div className="mx-1 h-5 w-px bg-border" />

      <Select
        value={effectiveActionType}
        onValueChange={(v) => { setActionType(v); setTargetQualityProfileId(null); }}
        disabled={controlsDisabled}
      >
        <SelectTrigger className="h-8 w-64">
          <SelectValue placeholder="Choose an action…" />
        </SelectTrigger>
        <SelectContent>
          {actionableFamilies.map((fam) => (
            <SelectGroup key={fam}>
              <SelectLabel>{FAMILY_LABEL[fam]}</SelectLabel>
              {ACTIONS_BY_FAMILY[fam].map((a) => {
                const value = a.value === "DO_NOTHING" ? `${TAG_ONLY_PREFIX}${fam}` : a.value;
                return (
                  <SelectItem key={value} value={value}>
                    {a.value === "DO_NOTHING" ? "Do Nothing (tags only)" : a.label}
                  </SelectItem>
                );
              })}
            </SelectGroup>
          ))}
        </SelectContent>
      </Select>

      {needsProfile && (
        <Select
          value={targetQualityProfileId != null ? String(targetQualityProfileId) : ""}
          onValueChange={(v) => setTargetQualityProfileId(Number(v))}
          disabled={controlsDisabled}
        >
          <SelectTrigger className="h-8 w-48">
            <SelectValue placeholder={meta && meta.qualityProfiles.length > 0 ? "Quality profile…" : "No profiles"} />
          </SelectTrigger>
          <SelectContent>
            {(meta?.qualityProfiles ?? []).map((p) => (
              <SelectItem key={p.id} value={String(p.id)}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      {supportsTags && (
        <>
          <TagPicker label="Add tags" options={meta?.tags ?? []} selected={addArrTags} onChange={setAddArrTags} disabled={controlsDisabled} />
          <TagPicker label="Remove tags" options={meta?.tags ?? []} selected={removeArrTags} onChange={setRemoveArrTags} disabled={controlsDisabled} />
        </>
      )}

      {supportsImportExclusion && (
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Checkbox checked={addImportExclusion} onCheckedChange={(c) => setAddImportExclusion(c === true)} disabled={controlsDisabled} />
          Add import exclusion
        </label>
      )}
      {supportsSearchAfter && (
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Checkbox checked={searchAfterAction} onCheckedChange={(c) => setSearchAfterAction(c === true)} disabled={controlsDisabled} />
          {needsProfile ? "Search for upgrade" : "Search after"}
        </label>
      )}

      <Button size="sm" className="h-8" disabled={!canRun} onClick={() => setConfirmOpen(true)}>
        {executing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
        Run action
      </Button>

      {noSelection ? (
        <span className="text-xs text-muted-foreground">Select results below to run an action.</span>
      ) : noFamilies ? (
        <span className="text-xs text-muted-foreground">
          Select an Arr instance above for the media type(s) you want to act on.
        </span>
      ) : null}

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Run “{actionLabel}”?</AlertDialogTitle>
            <AlertDialogDescription>
              This will run <strong>{actionLabel}</strong> on <strong>{targetCount.toLocaleString()}</strong>{" "}
              {family ? FAMILY_LABEL[family].toLowerCase() : ""} item{targetCount === 1 ? "" : "s"} immediately.
              {skippedCount > 0 && (
                <> {skippedCount.toLocaleString()} other selected item{skippedCount === 1 ? "" : "s"} of a different media type will be skipped.</>
              )}{" "}
              {willBatch && (
                <> Your selection runs in <strong>{batchCount}</strong> sequential batches of up to {MAX_QUERY_ACTION_ITEMS.toLocaleString()} items.</>
              )}{" "}
              {submittedActionType.includes("DELETE") && "This cannot be undone."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirm} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              Run action
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
