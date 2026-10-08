import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { executeActionsForItems } from "@/lib/lifecycle/run-actions";
import { checkDeleteCeiling } from "@/lib/lifecycle/delete-ceiling";
import { tryBeginExecute, endExecute } from "@/lib/lifecycle/execute-in-flight";
import { validateRequest, actionExecuteSchema } from "@/lib/validation";
import { actionHonorsMemberIds, isDestructiveActionType } from "@/lib/lifecycle/action-types";
import {
  findExceptedItemIds,
  findExceptionProtectedGroups,
  protectionKey,
  isWholeRecordDestructiveAction,
} from "@/lib/lifecycle/exception-guard";
import { sendDiscordNotification, buildFailureSummaryEmbed } from "@/lib/discord/client";
import { eventBus } from "@/lib/events/event-bus";
import { hasSeerrRules } from "@/lib/rules/lifecycle-engine";
import { checkPlayActivityExecutable } from "@/lib/lifecycle/evaluability";
import type { LifecycleRuleGroup } from "@/lib/rules/types";
import { matchIdentityChange } from "@/lib/lifecycle/match-identity";
import { memberIdsFromItemData } from "@/lib/lifecycle/group-aggregate";
import { getApiKeyPrincipal } from "@/lib/api-keys/principal";
import { destructiveRefusalResponse, reserveApiDestructive } from "@/lib/api-keys/destructive-budget";

/**
 * The episode / track ids each stored match acts on, keyed by its item — for
 * every match detection recorded them on: a series match in either scope and
 * an artist-scope music match. The scheduled path schedules its actions with
 * exactly these (`scheduleActionsForRuleSet`); reading them only for series
 * with series scope off sent a series-scope member-scoped file delete out with
 * no episodes (it deleted nothing and recorded COMPLETED) and an artist-scope
 * one with only the representative track, and the member exception checks
 * below never saw those members.
 */
function storedMemberIds(
  matches: Array<{ mediaItemId: string; itemData: unknown }>,
): Map<string, string[]> {
  const byItem = new Map<string, string[]>();
  for (const m of matches) {
    const ids = memberIdsFromItemData(m.itemData);
    if (ids.length > 0) byItem.set(m.mediaItemId, ids);
  }
  return byItem;
}

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await validateRequest(request, actionExecuteSchema);
  if (error) return error;

  const { ruleSetId } = data;
  // Duplicates would only repeat one id; dropping them keeps every count below
  // (the ceiling, the API budget, the log line) a count of distinct items.
  const mediaItemIds = data.mediaItemIds ? [...new Set(data.mediaItemIds)] : undefined;

  // Under an API key a missing `mediaItemIds` is refused, never read as "every
  // match": `/api/v1` validates this before calling here, and this repeats it
  // so the handler cannot be exposed to a key without it.
  const apiKey = getApiKeyPrincipal();
  if (apiKey && !mediaItemIds) {
    return NextResponse.json(
      { error: "mediaItemIds is required: name every item to act on" },
      { status: 400 }
    );
  }

  const ruleSet = await prisma.ruleSet.findFirst({
    where: { id: ruleSetId, userId: session.userId },
  });

  if (!ruleSet) {
    return NextResponse.json({ error: "Rule set not found" }, { status: 404 });
  }

  // SINGLE-FLIGHT — a live security review of the public API found that this
  // route (mirrored as `POST /api/v1/lifecycle/actions/execute`) ran the Arr
  // deletions inline with nothing serialising it: N overlapping POSTs for the
  // same rule set each loaded the same matches, each sent the same delete,
  // each recorded its own `deletedBytes` and each fired the Discord failure
  // summary — trivially from a script holding a key, or a double-clicked
  // Execute button. Claimed here, right after the rule set is loaded and
  // ownership-checked and BEFORE any side effect (the MUSIC+Seerr refusal
  // below disarms the rule set), and released in the `finally` whatever the
  // exit. A collision is answered, not queued: the work the second caller
  // asked for is already being done. A request naming items claims only those
  // (per-item Executes of one rule set run side by side); one naming none is
  // Execute All and claims the whole rule set. See `execute-in-flight.ts`.
  const lockedItems = mediaItemIds ? [...mediaItemIds] : undefined;
  if (!tryBeginExecute(ruleSet.id, lockedItems)) {
    return NextResponse.json(
      {
        error: lockedItems
          ? "An execution covering these items is already running for this rule set"
          : "An execution is already running for this rule set",
      },
      { status: 409 }
    );
  }
  try {
    return await executeRuleSet(session, ruleSet, mediaItemIds);
  } finally {
    endExecute(ruleSet.id, lockedItems);
  }
}

type RuleSetRow = NonNullable<Awaited<ReturnType<typeof prisma.ruleSet.findFirst>>>;

/**
 * The execution proper. Runs under the rule set's execute lock (see `POST`);
 * every early return here is a refusal the lock must still cover, because a
 * few of them (the MUSIC+Seerr disarm) write before they refuse.
 */
async function executeRuleSet(
  session: Awaited<ReturnType<typeof getSession>>,
  ruleSet: RuleSetRow,
  mediaItemIds: string[] | undefined,
): Promise<NextResponse> {
  // A disabled rule set must not fire destructive actions, even manually — the
  // scheduled execution path enforces this via its enabled filter, and a
  // disabled rule set can still hold matches (PUT with clearMatches=false), so
  // without this gate a manual "Execute" would bypass the backstop.
  if (!ruleSet.enabled) {
    return NextResponse.json(
      { error: "Rule set is disabled — enable it before executing actions" },
      { status: 400 }
    );
  }

  // Actions switched off is the same backstop one level down: the editor keeps
  // `actionType` when actions are turned off (so they can be turned back on),
  // detection keeps filling matches, and nothing schedules or runs them. The
  // Pending page only offers Execute for action-enabled rule sets, but this
  // route is also the public API's `POST /api/v1/lifecycle/actions/execute`,
  // where "turned off to review the matches first" must still mean off.
  if (!ruleSet.actionEnabled) {
    return NextResponse.json(
      { error: "Actions are turned off for this rule set — turn them on before executing" },
      { status: 400 }
    );
  }

  // Permanent-invalidity backstop (mirrors executeLifecycleActions): Seerr
  // criteria on a MUSIC rule set can never evaluate — Seerr has no music
  // requests, so every artist reads "never requested" and the stored matches
  // are a vacuous whole-library flood. Detection disarms such a rule set, but
  // matches armed before it ran are still listed on the Pending page, whose
  // Execute button calls this route. Disarm here too and refuse.
  if (ruleSet.type === "MUSIC" && hasSeerrRules(ruleSet.rules as unknown as LifecycleRuleGroup[])) {
    await prisma.lifecycleAction.deleteMany({ where: { ruleSetId: ruleSet.id, status: "PENDING" } });
    await prisma.ruleMatch.deleteMany({ where: { ruleSetId: ruleSet.id } });
    logger.warn("Lifecycle", `Refused manual execute for rule set "${ruleSet.name}" — Seerr criteria on a music library can never evaluate; cleared its vacuous matches`);
    return NextResponse.json(
      { error: "Seerr criteria are not supported on music rule sets — this rule set's matches were invalid and have been cleared" },
      { status: 400 }
    );
  }

  // Play-history hold, as the scheduled executor (`checkPlayActivityExecutable`):
  // the matches may be frozen from before an item was watched.
  const playHistoryRefusal = await checkPlayActivityExecutable(session.userId!, {
    rules: ruleSet.rules as unknown as LifecycleRuleGroup[],
    serverIds: ruleSet.serverIds,
    playHistoryPausedAt: ruleSet.playHistoryPausedAt,
  });
  if (playHistoryRefusal) {
    return NextResponse.json({ error: playHistoryRefusal }, { status: 409 });
  }

  const hasTagOps = ruleSet.addArrTags.length > 0 || ruleSet.removeArrTags.length > 0;

  if (!ruleSet.actionType && !hasTagOps) {
    return NextResponse.json(
      { error: "Rule set has no action configured" },
      { status: 400 }
    );
  }

  // Arr instance needed when: actionType is not DO_NOTHING, or tag operations are configured
  const needsArrInstance = (ruleSet.actionType && ruleSet.actionType !== "DO_NOTHING") || hasTagOps;
  if (needsArrInstance && !ruleSet.arrInstanceId) {
    return NextResponse.json(
      { error: "Rule set has no Arr instance configured" },
      { status: 400 }
    );
  }

  // CHANGE_QUALITY_PROFILE_* actions require a target profile id. Fast-fail
  // here so we don't write N FAILED rows — one per match — for a rule that
  // is misconfigured at the rule-set level. The UI guards against saving
  // such a rule, but a direct API write could still land us here.
  if (
    ruleSet.actionType &&
    ruleSet.actionType.startsWith("CHANGE_QUALITY_PROFILE_") &&
    ruleSet.targetQualityProfileId == null
  ) {
    return NextResponse.json(
      { error: "Rule set has no target quality profile configured" },
      { status: 400 }
    );
  }

  // Episode / track ids per matched item, wherever the stored match has them
  const episodeIdMap = new Map<string, string[]>();
  // What each match looked like when detection stored it, for the identity check.
  const snapshots = new Map<string, unknown>();

  // SAFETY: Only act on items that are stored matches for this rule set.
  // Never re-evaluate rules — use the persisted RuleMatch records as the
  // single source of truth. This ensures what the user sees on the matches
  // page is exactly what gets actioned.
  let itemIds: string[];

  if (!mediaItemIds || mediaItemIds.length === 0) {
    // "Execute All" — use all stored matches for this rule set
    const storedMatches = await prisma.ruleMatch.findMany({
      where: { ruleSetId: ruleSet.id },
      select: { mediaItemId: true, itemData: true },
    });

    if (storedMatches.length === 0) {
      return NextResponse.json(
        { error: "No matches found for this rule set — run detection first" },
        { status: 400 }
      );
    }

    itemIds = storedMatches.map((m) => m.mediaItemId);
    for (const m of storedMatches) snapshots.set(m.mediaItemId, m.itemData);

    for (const [id, members] of storedMemberIds(storedMatches)) episodeIdMap.set(id, members);

    logger.info("Lifecycle", `Manual execute all: ${storedMatches.length} stored matches for rule set "${ruleSet.id}"`);
  } else {
    // Specific items selected — validate ALL provided IDs are actual matches
    const validMatches = await prisma.ruleMatch.findMany({
      where: { ruleSetId: ruleSet.id, mediaItemId: { in: mediaItemIds } },
      select: { mediaItemId: true, itemData: true },
    });

    const validIds = new Set(validMatches.map((m) => m.mediaItemId));
    for (const m of validMatches) snapshots.set(m.mediaItemId, m.itemData);
    const invalidIds = mediaItemIds.filter((id) => !validIds.has(id));

    if (invalidIds.length > 0) {
      logger.warn("Lifecycle", `Rejected ${invalidIds.length} items not in matches for rule set "${ruleSet.id}": [${invalidIds.join(", ")}]`);
    }

    // Only action items that are confirmed matches
    itemIds = mediaItemIds.filter((id) => validIds.has(id));

    if (itemIds.length === 0) {
      return NextResponse.json(
        { error: "None of the provided items are matches for this rule set" },
        { status: 400 }
      );
    }

    for (const [id, members] of storedMemberIds(validMatches)) episodeIdMap.set(id, members);

    logger.info("Lifecycle", `Manual execute selected: ${itemIds.length} validated matches (${invalidIds.length} rejected) for rule set "${ruleSet.id}"`);
  }

  // Filter out items that have a LifecycleException — both representative
  // items AND episode/track MEMBERS (member ids never appear in itemIds, so
  // they must be collected from episodeIdMap and checked too).
  // An exception on another server's copy of an item (same dedupKey) counts.
  const memberIds = [...episodeIdMap.values()].flat();
  const excludedIds = await findExceptedItemIds(session.userId!, [...itemIds, ...memberIds]);
  if (excludedIds.size > 0) {

    // Drop excepted members from each item's member list; if a whole-record
    // destructive action would still touch an excepted member it cannot
    // exclude, drop the whole item rather than destroy a protected member.
    const honorsMembers = actionHonorsMemberIds(ruleSet.actionType ?? "");
    const destructive = isDestructiveActionType(ruleSet.actionType ?? "");
    for (const [repId, members] of [...episodeIdMap.entries()]) {
      const kept = members.filter((m) => !excludedIds.has(m));
      if (kept.length === members.length) continue;
      if (kept.length === 0 || (destructive && !honorsMembers)) {
        episodeIdMap.delete(repId);
        itemIds = itemIds.filter((id) => id !== repId);
      } else {
        episodeIdMap.set(repId, kept);
      }
    }

    itemIds = itemIds.filter((id) => !excludedIds.has(id));
    logger.info("Lifecycle", `Skipped excepted items/members during manual execution for rule set "${ruleSet.id}"`);

    if (itemIds.length === 0) {
      return NextResponse.json(
        { error: "All selected items are excluded from lifecycle actions" },
        { status: 400 }
      );
    }
  }

  // Fetch media items with external IDs (ownership-validated)
  let items = await prisma.mediaItem.findMany({
    where: {
      id: { in: itemIds },
      library: { mediaServer: { userId: session.userId } },
    },
    include: { externalIds: true },
  });

  // IDENTITY CHECK: a stored match names an item id, and a "Fix Match" on the
  // server can rewrite that row to a different work between detection and now
  // — the action would then resolve and act on the NEW work, which never
  // matched (see matchIdentityChange). Refuse the whole request rather than
  // run the rest: the stored match set is stale, and detection re-snapshots it.
  {
    const changed = items
      .map((item) => ({ item, why: matchIdentityChange(snapshots.get(item.id), item, ruleSet.type) }))
      .filter((c): c is { item: typeof items[number]; why: string } => c.why !== null);
    if (changed.length > 0) {
      const listed = changed
        .slice(0, 5)
        .map((c) => `${c.item.parentTitle ?? c.item.title} (${c.why})`)
        .join("; ");
      logger.warn("Lifecycle", `Refused manual execute for rule set "${ruleSet.id}" — ${changed.length} matched item(s) changed identity since detection: ${listed}`);
      return NextResponse.json(
        {
          error:
            `${changed.length} of the selected item(s) changed since the rules matched them: ${listed}` +
            `${changed.length > 5 ? "; …" : ""}. Nothing was executed. Run detection again, then review the matches.`,
        },
        { status: 409 }
      );
    }
  }

  // Exception inviolability, part 2: the member check above only sees MATCHED
  // episodes/tracks. A whole-record destructive action (e.g. DELETE_SONARR)
  // destroys the entire series/artist — including siblings the rule never
  // matched — so an exception on ANY item of the same parent must refuse it.
  if (isWholeRecordDestructiveAction(ruleSet.actionType ?? "")) {
    const protectedGroups = await findExceptionProtectedGroups(session.userId!, items);
    if (protectedGroups.size > 0) {
      const before = items.length;
      // `protectionKey` on both sides — see the guard: SERIES identity is
      // `seriesKey`, so an exception filed under another server's title for the
      // same show still protects this copy.
      items = items.filter((i) => {
        const key = protectionKey(i);
        return !key || !protectedGroups.has(key);
      });
      if (items.length < before) {
        logger.warn("Lifecycle", `Skipped ${before - items.length} whole-record ${ruleSet.actionType} target(s) for rule set "${ruleSet.id}" — an episode/track of the series/artist is excluded via lifecycle exception`);
      }
      if (items.length === 0) {
        return NextResponse.json(
          { error: "All selected items belong to series/artists with excluded episodes or tracks — a whole-record delete cannot exclude them" },
          { status: 400 }
        );
      }
    }
  }

  // SAFETY: Log the bounded execution count before starting any destructive operations
  // BLAST-RADIUS CEILING — applied to the manual path too, and on the final
  // `items` count so it reflects what would actually be destroyed rather than
  // what was requested. A human clicking "Execute All" has seen a LIST, not
  // necessarily its size, and the whole point of the ceiling is to catch the
  // case where the match set itself is wrong for a reason upstream of the rule.
  // Refusing outright (rather than confirming inline) keeps the decision in one
  // place — the setting — instead of training the user to click through a
  // dialog.
  {
    const verdict = await checkDeleteCeiling(
      session.userId!,
      items.map(() => ruleSet.actionType ?? "DO_NOTHING"),
    );
    if (!verdict.allowed) {
      logger.warn("Lifecycle", `Refused manual execute for rule set "${ruleSet.id}" — ${verdict.reason}`);
      return NextResponse.json({ error: verdict.reason }, { status: 400 });
    }
  }

  // PUBLIC API BUDGET: through an API key, a deleting action is charged — last,
  // on the final count, so what is charged is what will be acted on — to the
  // budget every key shares (at most 25 per request, 100 per hour). Refused
  // whole, like the ceiling: nothing runs and nothing is charged.
  const apiKey = getApiKeyPrincipal();
  if (apiKey && isDestructiveActionType(ruleSet.actionType ?? "")) {
    const reservation = reserveApiDestructive(items.length);
    if (!reservation.ok) {
      logger.warn("Lifecycle", `Refused API execute for rule set "${ruleSet.id}" by key "${apiKey.name}" — ${reservation.error}`);
      return destructiveRefusalResponse(reservation);
    }
  }

  logger.info("Lifecycle", `Executing ${ruleSet.actionType ?? "DO_NOTHING"} on ${items.length} items for rule set "${ruleSet.id}" (${itemIds.length} match IDs, ${items.length} ownership-verified)`);

  const { executed, failed, errors, failures } = await executeActionsForItems(
    session.userId!,
    items,
    {
      actionType: ruleSet.actionType ?? "DO_NOTHING",
      arrInstanceId: ruleSet.arrInstanceId,
      targetQualityProfileId: ruleSet.targetQualityProfileId,
      addImportExclusion: ruleSet.addImportExclusion,
      searchAfterAction: ruleSet.searchAfterAction,
      addArrTags: ruleSet.addArrTags,
      removeArrTags: ruleSet.removeArrTags,
    },
    episodeIdMap,
    {
      ruleSetId: ruleSet.id,
      ruleSetName: ruleSet.name,
      ruleSetType: ruleSet.type,
      cleanupMatches: true,
    },
  );

  // Send Discord notification for failures if the rule set has notifications enabled
  if (failed > 0 && ruleSet.discordNotifyOnAction) {
    try {
      const settings = await prisma.appSettings.findUnique({
        where: { userId: session.userId! },
        select: { discordWebhookUrl: true, discordWebhookUsername: true, discordWebhookAvatarUrl: true },
      });
      if (settings?.discordWebhookUrl) {
        await sendDiscordNotification(settings.discordWebhookUrl, {
          username: settings.discordWebhookUsername || "Librariarr",
          avatar_url: settings.discordWebhookAvatarUrl || undefined,
          embeds: [buildFailureSummaryEmbed(ruleSet.name, ruleSet.actionType ?? "DO_NOTHING", failures)],
        });
      }
    } catch {
      // Don't let notification failures break the response
    }
  }

  // Same event the scheduled executor emits. A manual Execute deletes media,
  // clears RuleMatch rows and moves the deletion stats — so the Pending list,
  // the Matches page and the dashboard pipeline are all stale the moment it
  // returns, and nothing was telling them.
  if (executed > 0 || failed > 0) {
    eventBus.emit({
      type: "lifecycle:action-executed",
      userId: session.userId!,
      meta: { executed, failed, manual: true },
    });
  }

  return NextResponse.json({ executed, failed, errors });
}
