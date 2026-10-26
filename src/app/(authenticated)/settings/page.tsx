"use client";

import { useState, useEffect, useCallback, useMemo, useRef, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { usePlexOAuth } from "@/hooks/use-plex-oauth";
import { fetchWithReauth } from "@/lib/auth/reauth-client";
import { fetchJsonShared } from "@/lib/shared-fetch";
import { createRequestBundle, type RequestBundle } from "@/lib/settings/request-bundle";
import { SETTINGS_BUNDLE_PATHS } from "@/lib/settings/settings-bundle-paths";
import { responseErrorMessage } from "@/lib/api/error-message";
import { PlexLoginPrompt } from "@/components/plex-login-prompt";
import { useRealtime } from "@/hooks/use-realtime";
import { useFallbackPoll } from "@/hooks/use-fallback-poll";
import { useCronScheduleSetting } from "@/hooks/use-cron-schedule-setting";
import { fetchSyncStatus } from "@/lib/sync/sync-status-client";
import { mergeSyncProgress } from "./sync-progress";
import { createPreloadedReads, type PreloadedReads } from "./preloaded-reads";
import {
  DEFAULT_CHIP_COLORS,
  mergeChipColors,
} from "@/lib/theme/chip-colors";
import type { ChipColorMap, ChipColorCategory } from "@/lib/theme/chip-colors";
import { useChipColors } from "@/components/chip-color-provider";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import {
  Server,
  Clock,
  Settings as SettingsIcon,
  Puzzle,
  Monitor,
  Bell,
  Lock,
  Sparkles,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { SettingsPanelSkeleton, SettingsSkeleton } from "@/components/skeletons";
import { isSyncRequestSettled, type PendingSyncRequest } from "@/lib/sync/sync-request";
import { readUrlHash, replaceUrlHash, subscribeToUrlHash } from "@/lib/url-hash";

// ─── Tab components ───
// Each tab's code loads on demand (`lazySettingsTab`), with its data: the
// page's own script carries none of them. Types only, from the tab modules.
import { lazySettingsTab } from "./lazy-tab";
import type { AddServerDialogState, AddServerFormState, PurgeDialogState, SyncPromptState, RemoveServerDialogState, ServerTestResult, WatchHistorySourceDialogState } from "./tabs/servers-tab";
import type { CredentialsForm, PromptForm } from "./tabs/authentication-tab";
import type { AiProvider } from "./tabs/ai-tab";

// ─── Shared types ───
import type {
  MediaServer,
  TracearrInstance,
  TracearrImportStatus,
  TracearrServerListState,
  PlexServer,
  ScheduleInfo,
  AuthInfo,
  SystemInfo,
  UpdateCheck,
  ImageCacheStats,
  RealtimeServerStatus,
  TestResult,
  BackupEntry,
  ReleaseNote,
} from "./types";
import { PRESET_VALUES } from "./types";
import { INTEGRATION_TYPES, type IntegrationInstance, type IntegrationType } from "./integration-instances";
import { newPasswordProblem } from "@/lib/auth/password-rules";

type IntegrationInstanceLists = Record<IntegrationType, IntegrationInstance[]>;
const NO_INTEGRATION_INSTANCES: IntegrationInstanceLists = {
  sonarr: [],
  radarr: [],
  lidarr: [],
  seerr: [],
  tracearr: [],
};

/** Stable empty reference — see `visibleTracearrImportStatus`. */
const NO_TRACEARR_IMPORT_STATUS: TracearrImportStatus[] = [];

// ─── Tab navigation ───

type SettingsTab = "general" | "scheduling" | "servers" | "integrations" | "notifications" | "authentication" | "ai" | "system";

const SETTINGS_TABS: { value: SettingsTab; label: string; icon: typeof SettingsIcon }[] = [
  { value: "general", label: "General", icon: SettingsIcon },
  { value: "scheduling", label: "Scheduling", icon: Clock },
  { value: "servers", label: "Media Servers", icon: Server },
  { value: "integrations", label: "Integrations", icon: Puzzle },
  { value: "notifications", label: "Notifications", icon: Bell },
  { value: "authentication", label: "Authentication", icon: Lock },
  { value: "ai", label: "AI", icon: Sparkles },
  { value: "system", label: "System", icon: Monitor },
];

const VALID_SETTINGS_TABS = new Set<string>(SETTINGS_TABS.map((t) => t.value));

const TAB_CODE = {
  general: lazySettingsTab(() => import("./tabs/general-tab").then((m) => m.GeneralTab)),
  scheduling: lazySettingsTab(() => import("./tabs/scheduling-tab").then((m) => m.SchedulingTab)),
  servers: lazySettingsTab(() => import("./tabs/servers-tab").then((m) => m.ServersTab)),
  integrations: lazySettingsTab(() => import("./tabs/integrations-tab").then((m) => m.IntegrationsTab)),
  notifications: lazySettingsTab(() => import("./tabs/notifications-tab").then((m) => m.NotificationsTab)),
  authentication: lazySettingsTab(() => import("./tabs/authentication-tab").then((m) => m.AuthenticationTab)),
  ai: lazySettingsTab(() => import("./tabs/ai-tab").then((m) => m.AiTab)),
  system: lazySettingsTab(() => import("./tabs/system-tab").then((m) => m.SystemTab)),
} satisfies Record<SettingsTab, { load: () => Promise<unknown> }>;

const GeneralTab = TAB_CODE.general.View;
const SchedulingTab = TAB_CODE.scheduling.View;
const ServersTab = TAB_CODE.servers.View;
const IntegrationsTab = TAB_CODE.integrations.View;
const NotificationsTab = TAB_CODE.notifications.View;
const AuthenticationTab = TAB_CODE.authentication.View;
const AiTab = TAB_CODE.ai.View;
const SystemTab = TAB_CODE.system.View;

/**
 * How often the Tracearr import status is re-read while a backfill is still
 * owed. Deliberately slow: the backfill runs for minutes-to-hours in
 * five-minute job slices, so a tighter poll would only add requests without
 * changing what the user reads. Polling stops the moment every mapped server
 * reports complete.
 */
const TRACEARR_IMPORT_POLL_MS = 30_000;
// Fallback for a dropped event stream only: connection changes are pushed as
// `server-status`, and a retry flipping between connecting and disconnected is
// deliberately not pushed, so this is what eventually shows it.
const REALTIME_STATUS_POLL_MS = 60_000;

/** The message to show for a failed integration save. */
const integrationSaveError = responseErrorMessage;


/** `useSyncExternalStore` subscriber for a value that never changes. */
const subscribeNothing = () => () => {};

/** The tab a URL hash names, or null for no hash or one that names none. */
function tabFromHash(hash: string): SettingsTab | null {
  const tab = hash.slice(1);
  return VALID_SETTINGS_TABS.has(tab) ? (tab as SettingsTab) : null;
}

/** Server snapshot for the URL hash: the server never sees it. */
const noUrlHash = () => "";

// ─── Tab navigation helpers ───

/** Sticky vertical sub-nav for the settings panel (handoff §11). */
function SettingsSubNav({
  activeTab,
  onTabChange,
  updateAvailable,
  latestVersion,
}: {
  activeTab: SettingsTab;
  onTabChange: (tab: SettingsTab) => void;
  updateAvailable?: boolean;
  latestVersion?: string | null;
}) {
  return (
    <nav
      role="tablist"
      aria-label="Settings sections"
      className="flex gap-1 overflow-x-auto lg:flex-col lg:overflow-visible [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {SETTINGS_TABS.map((tab) => {
        const Icon = tab.icon;
        const isActive = activeTab === tab.value;
        return (
          <button
            key={tab.value}
            role="tab"
            id={`settings-tab-${tab.value}`}
            aria-controls={`settings-panel-${tab.value}`}
            aria-selected={isActive}
            onClick={() => onTabChange(tab.value)}
            className={cn(
              "flex shrink-0 items-center gap-2.5 rounded-[9px] px-3 py-2 text-sm font-medium whitespace-nowrap transition-colors",
              isActive
                ? "bg-brand-dim text-brand-bright"
                : "text-muted-foreground hover:bg-surface-2 hover:text-foreground",
            )}
          >
            <Icon className="h-[17px] w-[17px] shrink-0" />
            <span className="flex-1 text-left">{tab.label}</span>
            {tab.value === "system" && updateAvailable && (
              <span
                className="h-2 w-2 shrink-0 rounded-full bg-green shadow-[0_0_8px_var(--green)]"
                title={latestVersion ? `Update available: v${latestVersion}` : "Update available"}
              />
            )}
          </button>
        );
      })}
    </nav>
  );
}

// ─── Main component ───

// The page's opening reads go out as one request (`GET /api/settings/bundle`);
// a fetcher's later reads, after a save or an event, go to its route. A fresh
// bundle per mount (`bundleRef`), so a revisit reads current values.
function bundleOf(ref: { current: RequestBundle | null }): RequestBundle {
  return (ref.current ??= createRequestBundle("/api/settings/bundle", SETTINGS_BUNDLE_PATHS));
}

/**
 * The opening reads of the Authentication tab's SSO and API key sections,
 * which fetch their own data when they mount: started with the tab's other
 * loaders (so the tab waits for them, and the bundle answers them), then
 * handed to the sections (`preloaded-reads.ts`).
 */
const AUTH_SECTION_PATHS = ["/api/settings/sso", "/api/settings/sso/me", "/api/settings/api-keys"] as const;

export default function SettingsPage() {
  const bundleRef = useRef<RequestBundle | null>(null);
  const authSectionReadsRef = useRef<PreloadedReads | null>(null);
  const authSectionReads = useCallback(
    () => (authSectionReadsRef.current ??= createPreloadedReads((path) => bundleOf(bundleRef).get(path))),
    [],
  );
  const preloadAuthSections = useCallback(
    () => Promise.all(AUTH_SECTION_PATHS.map((path) => authSectionReads().preload(path))),
    [authSectionReads],
  );
  const readAuthSectionData = useCallback((path: string) => authSectionReads().get(path), [authSectionReads]);
  // The open tab IS the URL hash — see `src/lib/url-hash.ts` for why it is
  // read through a store rather than once on mount.
  const urlHash = useSyncExternalStore(subscribeToUrlHash, readUrlHash, noUrlHash);
  const activeTab: SettingsTab = tabFromHash(urlHash) ?? "general";
  const setActiveTab = useCallback((tab: SettingsTab) => replaceUrlHash(`#${tab}`), []);
  // False only while server-rendering and hydrating. The open tab comes from
  // the URL hash, which the server cannot see, so until then the page renders
  // the skeleton the server did; a client-side navigation skips straight past.
  const hydrated = useSyncExternalStore(subscribeNothing, () => true, () => false);
  const [servers, setServers] = useState<MediaServer[]>([]);
  // Whether the Integrations tab has been open (see its TabsContent). Set
  // during render, the way React derives state from a changed value.
  const [integrationsOpened, setIntegrationsOpened] = useState(false);
  if (activeTab === "integrations" && !integrationsOpened) setIntegrationsOpened(true);
  // Tabs whose data has loaded — each tab renders once its own requests are in.
  const [loadedTabs, setLoadedTabs] = useState<ReadonlySet<SettingsTab>>(() => new Set());
  // The manual sync this page last requested, until its own run ends — see
  // `isSyncRequestSettled` for how that run is told apart from the previous one.
  const [syncRequest, setSyncRequest] = useState<PendingSyncRequest | null>(null);
  const syncRequestSeq = useRef(0);
  const [testingServer, setTestingServer] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<ServerTestResult | null>(null);
  const [refreshingLibraries, setRefreshingLibraries] = useState<string | null>(null);

  // Add server dialog
  const [addServerDialog, setAddServerDialog] = useState<AddServerDialogState | null>(null);
  const [addServerForm, setAddServerForm] = useState<AddServerFormState>({ name: "", url: "", apiKey: "", tlsSkipVerify: false });
  const [addServerSaving, setAddServerSaving] = useState(false);
  const [addServerError, setAddServerError] = useState("");
  const [addServerTesting, setAddServerTesting] = useState(false);
  const [addServerTestResult, setAddServerTestResult] = useState<TestResult | null>(null);

  // Authentication tab state
  const [authInfo, setAuthInfo] = useState<AuthInfo | null>(null);
  const [authLoading, setAuthLoading] = useState(false);
  // Plex OAuth for auth tab (link account, stay on settings)
  const plexOAuth = usePlexOAuth({
    onSuccess: async (authToken) => {
      const linkRes = await fetchWithReauth("/api/auth/plex/link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ authToken }),
      });
      const linkData = await linkRes.json();
      if (linkData.linked) {
        const infoRes = await bundleOf(bundleRef).get("/api/settings/auth");
        setAuthInfo(await infoRes.json());
        if (linkData.plexLoginEnabled === false) setPlexLoginPrompt({ then: null });
      } else if (linkData.error) {
        throw new Error(linkData.error);
      }
    },
  });
  // Plex OAuth for servers tab (link account, then redirect to onboarding)
  const plexOAuthForOnboarding = usePlexOAuth({
    onSuccess: async (authToken) => {
      const linkRes = await fetchWithReauth("/api/auth/plex/link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ authToken }),
      });
      const linkData = await linkRes.json();
      if (linkData.linked) {
        // Ask about Plex login first; the prompt continues to onboarding.
        if (linkData.plexLoginEnabled === false) {
          setPlexLoginPrompt({ then: "/onboarding" });
        } else {
          window.location.assign("/onboarding");
        }
      } else if (linkData.error) {
        throw new Error(linkData.error);
      }
    },
  });
  const plexLinking = plexOAuth.isLoading || plexOAuthForOnboarding.isLoading;
  // Open after a Plex link while Plex login is off; `then` is where to go next.
  const [plexLoginPrompt, setPlexLoginPrompt] = useState<{ then: string | null } | null>(null);
  const [credentialsForm, setCredentialsForm] = useState<CredentialsForm>({
    currentPassword: "",
    newUsername: "",
    newPassword: "",
    confirmPassword: "",
  });
  const [credentialsSaving, setCredentialsSaving] = useState(false);
  const [credentialsError, setCredentialsError] = useState("");
  const [plexLoginError, setPlexLoginError] = useState("");
  const [localAuthError, setLocalAuthError] = useState("");
  const [credentialsSuccess, setCredentialsSuccess] = useState("");
  const [showCredentialPrompt, setShowCredentialPrompt] = useState(false);
  const [promptForm, setPromptForm] = useState<PromptForm>({ username: "", password: "", confirmPassword: "" });
  const [promptError, setPromptError] = useState("");
  const [promptSaving, setPromptSaving] = useState(false);

  // Library purge dialog
  const [purgeDialog, setPurgeDialog] = useState<PurgeDialogState | null>(null);
  const [purging, setPurging] = useState(false);

  // Sync prompt after enabling library
  const [syncPrompt, setSyncPrompt] = useState<SyncPromptState | null>(null);

  // Remove server dialog
  const [removeServerDialog, setRemoveServerDialog] = useState<RemoveServerDialogState | null>(null);
  const [removingServer, setRemovingServer] = useState(false);

  // Watch history source (Tracearr ↔ media server mapping)
  const [tracearrServerLists, setTracearrServerLists] = useState<Record<string, TracearrServerListState>>({});
  /** Per-mapped-server import progress; empty until the first status response. */
  const [tracearrImportStatus, setTracearrImportStatus] = useState<TracearrImportStatus[]>([]);
  const [watchHistorySourceDialog, setWatchHistorySourceDialog] = useState<WatchHistorySourceDialogState | null>(null);
  const [savingWatchHistorySource, setSavingWatchHistorySource] = useState<string | null>(null);

  // Scheduled job time
  const [scheduledJobTime, setScheduledJobTime] = useState("00:00");
  const [savingJobTime, setSavingJobTime] = useState(false);

  // When each schedule last ran (the schedules themselves: useCronScheduleSetting below)
  const [lastScheduledSync, setLastScheduledSync] = useState<string | null>(null);
  const [lastLcDetect, setLastLcDetect] = useState<string | null>(null);
  const [lastLcExec, setLastLcExec] = useState<string | null>(null);
  const [runningJob, setRunningJob] = useState<"sync" | "detection" | "execution" | null>(null);

  // Each integration type's instances (the forms live in the Integrations tab)
  const [integrationInstances, setIntegrationInstances] = useState<IntegrationInstanceLists>(NO_INTEGRATION_INSTANCES);
  const tracearrInstances: TracearrInstance[] = integrationInstances.tracearr;

  // System info
  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null);
  // Whether a newer release exists, for the System tab's version line and the
  // dot beside its name. Nothing waits on it.
  const [updateCheck, setUpdateCheck] = useState<UpdateCheck | null>(null);

  // Image cache
  const [imageCacheStats, setImageCacheStats] = useState<ImageCacheStats | null>(null);
  const [clearingImageCache, setClearingImageCache] = useState(false);

  // Changelog
  const [releaseNotes, setReleaseNotes] = useState<ReleaseNote[]>([]);
  // True until the first fetch ends: release notes are requested only once the
  // System tab is opened, and that tab must not read "unable to load" before.
  const [loadingChangelog, setLoadingChangelog] = useState(true);

  // Server editing
  const [editingServerId, setEditingServerId] = useState<string | null>(null);
  const [editServerUrl, setEditServerUrl] = useState("");
  const [editServerExternalUrl, setEditServerExternalUrl] = useState("");
  const [editServerAccessToken, setEditServerAccessToken] = useState("");
  const [editServerTlsSkip, setEditServerTlsSkip] = useState(false);
  const [editServerSaving, setEditServerSaving] = useState(false);
  const [editServerError, setEditServerError] = useState("");
  const [plexServers, setPlexServers] = useState<PlexServer[]>([]);
  const [loadingPlexConnections, setLoadingPlexConnections] = useState(false);

  // Accent color
  const [accentColor, setAccentColor] = useState("default");

  // Preferred title/artwork source
  const [preferredTitleServerId, setPreferredTitleServerId] = useState<string | null>(null);
  const [preferredArtworkServerId, setPreferredArtworkServerId] = useState<string | null>(null);

  // Chip colors
  const [chipColors, setChipColors] = useState<ChipColorMap>(DEFAULT_CHIP_COLORS);
  const { updateColors: updateChipColorContext } = useChipColors();


  // Log retention
  const [logRetentionDays, setLogRetentionDays] = useState(7);
  // Backup
  const [backupSchedule, setBackupSchedule] = useState("DAILY");
  const [backupRetentionCount, setBackupRetentionCount] = useState(7);
  const [backups, setBackups] = useState<BackupEntry[]>([]);
  const [backupLoading, setBackupLoading] = useState(false);
  const [backupSaving, setBackupSaving] = useState(false);
  const [creatingBackup, setCreatingBackup] = useState(false);
  const [restoringBackup, setRestoringBackup] = useState<string | null>(null);
  const [downloadingBackups, setDownloadingBackups] = useState<string[]>([]);
  const [restoreProgress, setRestoreProgress] = useState<string | null>(null);
  const [hasBackupPassword, setHasBackupPassword] = useState(false);
  const [savingBackupPassword, setSavingBackupPassword] = useState(false);
  const [logRetentionInput, setLogRetentionInput] = useState("7");
  const [savingLogRetention, setSavingLogRetention] = useState(false);
  // Action history retention
  const [actionRetentionDays, setActionRetentionDays] = useState(30);
  const [actionRetentionInput, setActionRetentionInput] = useState("30");
  const [savingActionRetention, setSavingActionRetention] = useState(false);
  const [dedupStats, setDedupStats] = useState(true);
  const [savingDedup, setSavingDedup] = useState(false);
  const [realtimeSync, setRealtimeSync] = useState(true);
  const [savingRealtime, setSavingRealtime] = useState(false);
  const [realtimeServers, setRealtimeServers] = useState<RealtimeServerStatus[]>([]);

  // Schedule info (next run times)
  const [scheduleInfo, setScheduleInfo] = useState<ScheduleInfo | null>(null);

  // Discord notification settings
  const [discordWebhookUrl, setDiscordWebhookUrl] = useState("");
  const [discordWebhookUsername, setDiscordWebhookUsername] = useState("");
  const [discordWebhookAvatarUrl, setDiscordWebhookAvatarUrl] = useState("");
  const [discordNotifyApiKeys, setDiscordNotifyApiKeys] = useState(true);
  const [discordSaving, setDiscordSaving] = useState(false);
  const [discordTesting, setDiscordTesting] = useState(false);
  const [discordTestResult, setDiscordTestResult] = useState<TestResult | null>(null);

  // AI assistant settings
  const [aiEnabled, setAiEnabled] = useState(false);
  const [aiProvider, setAiProvider] = useState<AiProvider>("openai-compatible");
  const [aiBaseUrl, setAiBaseUrl] = useState("");
  const [aiApiKey, setAiApiKey] = useState("");
  const [aiModel, setAiModel] = useState("");
  const [aiSaving, setAiSaving] = useState(false);
  const [aiTesting, setAiTesting] = useState(false);
  const [aiTestResult, setAiTestResult] = useState<TestResult | null>(null);

  // A URL naming no tab (/settings alone, or an unknown hash) is pointed at
  // the General tab it shows. Read live, not from this render's `activeTab`:
  // on a client-side navigation this runs before the store has re-read the
  // hash the router just wrote, and normalising from the render's value
  // overwrote #authentication with #general.
  useEffect(() => {
    if (!tabFromHash(readUrlHash())) replaceUrlHash("#general");
  }, [urlHash]);

  // ─── Fetchers ───

  // Bumped each time a server list is applied: a progress read that was asked
  // for before it may be older than that list (see `fetchSyncProgress`).
  const serversRead = useRef(0);
  const fetchServers = useCallback(async (): Promise<MediaServer[]> => {
    try {
      const response = await bundleOf(bundleRef).get("/api/servers");
      const data = await response.json();
      const fresh: MediaServer[] = data.servers || [];
      serversRead.current += 1;
      setServers(fresh);
      // Drop a request whose run has ended. Deriving that during render is not
      // enough on its own: a request left stored after its run finished would
      // light the spinner again for the next scheduled or realtime sync of the
      // same server.
      setSyncRequest((current) => (current && isSyncRequestSettled(current, fresh) ? null : current));
      return fresh;
    } catch (error) {
      console.error("Failed to fetch servers:", error);
      return [];
    }
  }, []);

  const fetchScheduleInfo = useCallback(async () => {
    try {
      const response = await bundleOf(bundleRef).get("/api/settings/schedule-info");
      const data = await response.json();
      setScheduleInfo(data);
      if (data.scheduledJobTime) {
        setScheduledJobTime(data.scheduledJobTime);
      }
      // Keep the cards' "Last run" values in sync. These states are otherwise
      // only populated by fetchSettings/fetchLifecycleSchedule, so without
      // this a "Run Now" (which refreshes schedule-info) wouldn't update them.
      if (data.sync) setLastScheduledSync(data.sync.lastRun ?? null);
      if (data.detection) setLastLcDetect(data.detection.lastRun ?? null);
      if (data.execution) setLastLcExec(data.execution.lastRun ?? null);
    } catch (error) {
      console.error("Failed to fetch schedule info:", error);
    }
  }, []);


  // The three schedules: a preset picker or a custom cron expression each,
  // saved to its route, after which the next-run times are re-read.
  const syncSchedule = useCronScheduleSetting({
    endpoint: "/api/settings/sync-schedule",
    bodyKey: "syncSchedule",
    successMsg: "Sync schedule saved",
    refresh: fetchScheduleInfo,
    presets: PRESET_VALUES,
    initial: "DAILY",
  });
  const detectionSchedule = useCronScheduleSetting({
    endpoint: "/api/settings/lifecycle-schedule",
    bodyKey: "lifecycleDetectionSchedule",
    successMsg: "Detection schedule saved",
    refresh: fetchScheduleInfo,
    presets: PRESET_VALUES,
    initial: "EVERY_6H",
  });
  const executionSchedule = useCronScheduleSetting({
    endpoint: "/api/settings/lifecycle-schedule",
    bodyKey: "lifecycleExecutionSchedule",
    successMsg: "Execution schedule saved",
    refresh: fetchScheduleInfo,
    presets: PRESET_VALUES,
    initial: "EVERY_6H",
  });
  const { load: loadSyncSchedule } = syncSchedule;
  const { load: loadDetectionSchedule } = detectionSchedule;
  const { load: loadExecutionSchedule } = executionSchedule;

  const fetchSettings = useCallback(async () => {
    try {
      const response = await bundleOf(bundleRef).get("/api/settings/sync-schedule");
      const data = await response.json();
      if (data.settings) {
        loadSyncSchedule(data.settings.syncSchedule);
        setLastScheduledSync(data.settings.lastScheduledSync);
      }
    } catch (error) {
      console.error("Failed to fetch settings:", error);
    }
  }, [loadSyncSchedule]);

  const fetchDedupSetting = useCallback(async () => {
    try {
      const response = await bundleOf(bundleRef).get("/api/settings/dedup");
      if (response.ok) {
        const data = await response.json();
        setDedupStats(data.dedupStats ?? true);
      }
    } catch {
      // Silent
    }
  }, []);

  const fetchRealtimeSetting = useCallback(async () => {
    try {
      const response = await bundleOf(bundleRef).get("/api/settings/realtime");
      if (response.ok) {
        const data = await response.json();
        setRealtimeSync(data.realtimeSync ?? true);
      }
    } catch {
      // Silent
    }
  }, []);

  const fetchRealtimeStatus = useCallback(async () => {
    try {
      const response = await bundleOf(bundleRef).get("/api/tools/realtime/status");
      if (response.ok) {
        const data = await response.json();
        setRealtimeServers(data.servers ?? []);
      }
    } catch {
      // Silent — the indicator keeps its last state
    }
  }, []);

  const fetchIntegrationInstances = useCallback(async (type: IntegrationType) => {
    try {
      const response = await bundleOf(bundleRef).get(`/api/integrations/${type}`);
      const data = await response.json();
      const instances: IntegrationInstance[] = data.instances || [];
      setIntegrationInstances((current) => ({ ...current, [type]: instances }));
    } catch (error) {
      console.error(`Failed to fetch ${type} instances:`, error);
    }
  }, []);
  // One fetcher per type, kept stable: `startOnce` runs each once by identity.
  const integrationFetchers = useMemo(
    () =>
      Object.fromEntries(INTEGRATION_TYPES.map((type) => [type, () => fetchIntegrationInstances(type)])) as Record<
        IntegrationType,
        () => Promise<void>
      >,
    [fetchIntegrationInstances],
  );

  /**
   * The media servers one Tracearr instance monitors, for the per-server
   * watch-history-source dropdown. A failure is stored rather than swallowed:
   * the dropdown shows it and stays disabled, because an empty option list
   * would read as "Tracearr monitors nothing" instead of "we couldn't ask it".
   */
  const fetchTracearrServers = useCallback(async (instanceId: string) => {
    setTracearrServerLists((prev) => ({
      ...prev,
      [instanceId]: { loading: true, error: null, servers: prev[instanceId]?.servers ?? [] },
    }));
    try {
      const response = await fetch(`/api/integrations/tracearr/${instanceId}/servers`);
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        setTracearrServerLists((prev) => ({
          ...prev,
          [instanceId]: {
            loading: false,
            error: data?.detail ?? data?.error ?? "Failed to load servers",
            servers: [],
          },
        }));
        return;
      }
      setTracearrServerLists((prev) => ({
        ...prev,
        [instanceId]: { loading: false, error: null, servers: data?.servers ?? [] },
      }));
    } catch (error) {
      console.error("Failed to fetch Tracearr servers:", error);
      setTracearrServerLists((prev) => ({
        ...prev,
        [instanceId]: { loading: false, error: "Request failed", servers: [] },
      }));
    }
  }, []);

  /**
   * How far the Tracearr import has got, per mapped server, for the status
   * line under each watch-history-source dropdown.
   *
   * A failure clears the list instead of storing an error the way
   * `fetchTracearrServers` does: this is a progress readout beside a working
   * control, not the control itself, so a transient blip should make the line
   * disappear rather than plant an error next to a setting that is fine.
   */
  const fetchTracearrImportStatus = useCallback(async () => {
    try {
      const response = await fetch("/api/integrations/tracearr/status");
      if (!response.ok) {
        setTracearrImportStatus([]);
        return;
      }
      const data = (await response.json()) as { servers?: TracearrImportStatus[] };
      setTracearrImportStatus(data.servers ?? []);
    } catch (error) {
      console.error("Failed to fetch Tracearr import status:", error);
      setTracearrImportStatus([]);
    }
  }, []);

  // Without the update check: that is a GitHub lookup, fetched on its own
  // (`fetchUpdateCheck`) so the System tab never waits on GitHub.
  const fetchSystemInfo = useCallback(async () => {
    try {
      const response = await fetch("/api/system/info?updateCheck=false");
      const data = await response.json();
      setSystemInfo(data);
    } catch (error) {
      console.error("Failed to fetch system info:", error);
    }
  }, []);

  const fetchUpdateCheck = useCallback(async () => {
    try {
      // Shared with the sidebar's update dot, which reads it on the same mount.
      const data = await fetchJsonShared<UpdateCheck>("/api/system/update-check", { priority: "low" });
      if (data) setUpdateCheck(data);
    } catch {
      // Silent — no update dot and no version status, nothing else
    }
  }, []);

  const fetchChangelog = useCallback(async () => {
    setLoadingChangelog(true);
    try {
      const response = await fetch("/api/system/changelog");
      const data = await response.json();
      setReleaseNotes(data.notes ?? []);
    } catch (error) {
      console.error("Failed to fetch changelog:", error);
    } finally {
      setLoadingChangelog(false);
    }
  }, []);

  const fetchImageCacheStats = useCallback(async () => {
    try {
      const response = await fetch("/api/settings/image-cache");
      const data = await response.json();
      setImageCacheStats(data);
    } catch (error) {
      console.error("Failed to fetch image cache stats:", error);
    }
  }, []);

  const fetchAccentColor = useCallback(async () => {
    try {
      const response = await bundleOf(bundleRef).get("/api/settings/accent-color");
      const data = await response.json();
      if (data.accentColor) {
        setAccentColor(data.accentColor);
      }
    } catch (error) {
      console.error("Failed to fetch accent color:", error);
    }
  }, []);

  const fetchChipColors = useCallback(async () => {
    try {
      const response = await bundleOf(bundleRef).get("/api/settings/chip-colors");
      const data = await response.json();
      if (data.chipColors) {
        setChipColors(mergeChipColors(data.chipColors));
      }
    } catch (error) {
      console.error("Failed to fetch chip colors:", error);
    }
  }, []);

  const fetchLogRetention = useCallback(async () => {
    try {
      const response = await bundleOf(bundleRef).get("/api/settings/log-retention");
      const data = await response.json();
      setLogRetentionDays(data.logRetentionDays ?? 7);
      setLogRetentionInput(String(data.logRetentionDays ?? 7));
    } catch (error) {
      console.error("Failed to fetch log retention:", error);
    }
  }, []);

  // Blank string = no ceiling, which is the default. `savedDeleteCeiling`
  // mirrors what is persisted so the Save button can tell "unchanged" from
  // "cleared", which a number-or-null pair could not express on its own.
  const [deleteCeilingInput, setDeleteCeilingInput] = useState("");
  const [savedDeleteCeiling, setSavedDeleteCeiling] = useState("");
  const [savingDeleteCeiling, setSavingDeleteCeiling] = useState(false);

  const fetchDeleteCeiling = useCallback(async () => {
    try {
      const response = await bundleOf(bundleRef).get("/api/settings/delete-ceiling");
      const data = await response.json();
      const value = data.maxAutoDeleteItems == null ? "" : String(data.maxAutoDeleteItems);
      setDeleteCeilingInput(value);
      setSavedDeleteCeiling(value);
    } catch (error) {
      console.error("Failed to fetch delete ceiling:", error);
    }
  }, []);

  const saveDeleteCeiling = async () => {
    const trimmed = deleteCeilingInput.trim();
    // An empty field is the meaningful "no limit" value, not a validation
    // failure — sending null is how the ceiling gets cleared.
    const value = trimmed === "" ? null : parseInt(trimmed);
    if (value !== null && (isNaN(value) || value < 1)) {
      toast.error("Enter a number of at least 1, or leave it empty for no limit");
      return;
    }
    setSavingDeleteCeiling(true);
    try {
      const response = await fetch("/api/settings/delete-ceiling", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxAutoDeleteItems: value }),
      });
      if (response.ok) {
        setSavedDeleteCeiling(value === null ? "" : String(value));
        setDeleteCeilingInput(value === null ? "" : String(value));
        toast.success(value === null ? "Deletion limit removed" : "Deletion limit saved");
      } else {
        toast.error("Failed to save deletion limit");
      }
    } catch {
      toast.error("Failed to save deletion limit");
    } finally {
      setSavingDeleteCeiling(false);
    }
  };

  const fetchActionRetention = useCallback(async () => {
    try {
      const response = await bundleOf(bundleRef).get("/api/settings/action-retention");
      const data = await response.json();
      setActionRetentionDays(data.actionHistoryRetentionDays ?? 30);
      setActionRetentionInput(String(data.actionHistoryRetentionDays ?? 30));
    } catch (error) {
      console.error("Failed to fetch action retention:", error);
    }
  }, []);

  const fetchBackupSettings = useCallback(async () => {
    setBackupLoading(true);
    try {
      const [scheduleRes, listRes, encRes] = await Promise.all([
        bundleOf(bundleRef).get("/api/settings/backup-schedule"),
        bundleOf(bundleRef).get("/api/backup"),
        bundleOf(bundleRef).get("/api/settings/backup-encryption-password"),
      ]);
      if (scheduleRes.ok) {
        const data = await scheduleRes.json();
        setBackupSchedule(data.backupSchedule ?? "DAILY");
        setBackupRetentionCount(data.backupRetentionCount ?? 7);
      }
      if (listRes.ok) {
        const data = await listRes.json();
        setBackups(data.backups ?? []);
      }
      if (encRes.ok) {
        const data = await encRes.json();
        setHasBackupPassword(data.hasPassword ?? false);
      }
    } catch {
      // Silent
    } finally {
      setBackupLoading(false);
    }
  }, []);

  const fetchLifecycleSchedule = useCallback(async () => {
    try {
      const response = await bundleOf(bundleRef).get("/api/settings/lifecycle-schedule");
      // The route answers the fields at the top level, not under `settings` as
      // the sync schedule's does: read under `settings`, a stored schedule was
      // never shown, and both pickers read "Every 6 hours" whatever was saved.
      const data = (await response.json()) as {
        lifecycleDetectionSchedule?: string;
        lastScheduledLifecycleDetection?: string | null;
        lifecycleExecutionSchedule?: string;
        lastScheduledLifecycleExecution?: string | null;
      };
      if (response.ok && data.lifecycleDetectionSchedule && data.lifecycleExecutionSchedule) {
        loadDetectionSchedule(data.lifecycleDetectionSchedule);
        setLastLcDetect(data.lastScheduledLifecycleDetection ?? null);
        loadExecutionSchedule(data.lifecycleExecutionSchedule);
        setLastLcExec(data.lastScheduledLifecycleExecution ?? null);
      }
    } catch (error) {
      console.error("Failed to fetch lifecycle schedule:", error);
    }
  }, [loadDetectionSchedule, loadExecutionSchedule]);

  const fetchDiscordSettings = useCallback(async () => {
    try {
      const response = await bundleOf(bundleRef).get("/api/settings/discord");
      const data = await response.json();
      setDiscordWebhookUrl(data.webhookUrl ?? "");
      setDiscordWebhookUsername(data.webhookUsername ?? "");
      setDiscordWebhookAvatarUrl(data.webhookAvatarUrl ?? "");
      setDiscordNotifyApiKeys(data.notifyApiKeys ?? true);
    } catch (error) {
      console.error("Failed to fetch Discord settings:", error);
    }
  }, []);

  const fetchAiSettings = useCallback(async () => {
    try {
      const response = await bundleOf(bundleRef).get("/api/settings/ai");
      const data = await response.json();
      setAiEnabled(!!data.enabled);
      setAiProvider((data.provider as AiProvider) ?? "openai-compatible");
      setAiBaseUrl(data.baseUrl ?? "");
      setAiApiKey(data.apiKey ?? "");
      setAiModel(data.model ?? "");
    } catch (error) {
      console.error("Failed to fetch AI settings:", error);
    }
  }, []);

  const fetchAuthInfo = useCallback(async () => {
    try {
      const response = await bundleOf(bundleRef).get("/api/settings/auth");
      if (response.ok) setAuthInfo(await response.json());
    } catch {
      // Silent
    }
  }, []);

  const fetchTitlePreference = useCallback(async () => {
    try {
      const response = await bundleOf(bundleRef).get("/api/settings/title-preference");
      if (response.ok) {
        const data = await response.json();
        setPreferredTitleServerId(data.preferredTitleServerId ?? null);
        setPreferredArtworkServerId(data.preferredArtworkServerId ?? null);
      }
    } catch {
      // Silent
    }
  }, []);

  // ─── Initial data loading ───

  // Each tab renders as soon as its OWN data is in. The page used to wait for
  // every tab's — two dozen requests, including the GitHub release check
  // behind system info — so the slowest of them decided when anything showed.
  // The open tab's requests go out first (the browser serves a handful of
  // same-origin requests at a time, in the order they were made) and the other
  // tabs load behind them, so switching tabs afterwards is still instant —
  // except System, whose figures (release notes from GitHub, a scan of the
  // image cache, whole-table counts) are requested only once it is opened.
  // A tab's own code is one of its loaders (`TAB_CODE`), first in its list.
  const tabLoaders = useMemo<Record<SettingsTab, Array<() => Promise<unknown>>>>(
    () => ({
      general: [
        TAB_CODE.general.load,
        fetchAccentColor,
        fetchChipColors,
        fetchDedupSetting,
        fetchRealtimeSetting,
        fetchRealtimeStatus,
        fetchLogRetention,
        fetchActionRetention,
        fetchDeleteCeiling,
        fetchBackupSettings,
        fetchServers,
        fetchTitlePreference,
      ],
      scheduling: [TAB_CODE.scheduling.load, fetchSettings, fetchLifecycleSchedule, fetchScheduleInfo],
      servers: [TAB_CODE.servers.load, fetchServers, integrationFetchers.tracearr, fetchAuthInfo],
      integrations: [TAB_CODE.integrations.load, ...INTEGRATION_TYPES.map((type) => integrationFetchers[type])],
      notifications: [TAB_CODE.notifications.load, fetchDiscordSettings],
      authentication: [TAB_CODE.authentication.load, fetchAuthInfo, preloadAuthSections],
      ai: [TAB_CODE.ai.load, fetchAiSettings],
      system: [TAB_CODE.system.load, fetchSystemInfo, fetchImageCacheStats],
    }),
    [fetchServers, fetchSettings, integrationFetchers, fetchSystemInfo, fetchAccentColor, fetchChipColors, fetchLogRetention, fetchActionRetention, fetchDeleteCeiling, fetchBackupSettings, fetchLifecycleSchedule, fetchScheduleInfo, fetchDiscordSettings, fetchAiSettings, fetchDedupSetting, fetchRealtimeSetting, fetchRealtimeStatus, fetchImageCacheStats, fetchAuthInfo, fetchTitlePreference, preloadAuthSections],
  );

  // A fetcher two tabs share, or a tab opened twice, runs once.
  const startedFetches = useRef(new Map<() => Promise<unknown>, Promise<unknown>>());
  const startOnce = useCallback((fetcher: () => Promise<unknown>) => {
    let pending = startedFetches.current.get(fetcher);
    if (!pending) {
      pending = fetcher();
      startedFetches.current.set(fetcher, pending);
    }
    return pending;
  }, []);

  const loadTab = useCallback(
    async (tab: SettingsTab) => {
      await Promise.allSettled(tabLoaders[tab].map(startOnce));
      setLoadedTabs((prev) => (prev.has(tab) ? prev : new Set(prev).add(tab)));
    },
    [tabLoaders, startOnce],
  );

  // Declared before the effect below so that, with the page opened at #system,
  // the open tab's requests are the first to go out (effects run in order).
  useEffect(() => {
    if (activeTab !== "system") return;
    void (async () => {
      // Release notes have their own loading state, so the tab does not wait
      // for them.
      await Promise.all([loadTab("system"), startOnce(fetchChangelog)]);
    })();
  }, [activeTab, loadTab, startOnce, fetchChangelog]);

  useEffect(() => {
    const openTab = tabFromHash(readUrlHash()) ?? "general";
    const eager = [openTab, ...SETTINGS_TABS.map((t) => t.value).filter((tab) => tab !== openTab)].filter(
      (tab) => tab !== "system",
    );
    void (async () => {
      // The update check feeds only the System tab's dot and version line, so
      // it goes out last and no tab waits for it.
      await Promise.all([...eager.map(loadTab), fetchUpdateCheck()]);
    })();
  }, [loadTab, fetchUpdateCheck]);

  // Load each enabled Tracearr instance's server list lazily — nothing is
  // requested until an instance exists, so the (common) native-history setup
  // pays nothing for the mapping dropdown. The dependency is a joined id
  // string, not the array, so refreshing the instance list doesn't refetch
  // every server list on every render.
  const enabledTracearrIds = tracearrInstances.filter((i) => i.enabled).map((i) => i.id).join(",");
  useEffect(() => {
    if (!enabledTracearrIds) return;
    // Kicked off from an async IIFE (the idiom the initial-load effect above
    // uses) rather than called directly: `fetchTracearrServers` sets its
    // loading flag before its first await, and a setState that runs
    // synchronously inside an effect body triggers a cascading render.
    void (async () => {
      await Promise.all(
        enabledTracearrIds.split(",").map((id) => fetchTracearrServers(id)),
      );
    })();
  }, [enabledTracearrIds, fetchTracearrServers]);

  // Import progress for the mapped servers. Gated on an instance existing at
  // all — including a disabled one, which can still own a live mapping — so
  // the (overwhelmingly common) native-history setup never issues the request.
  // The state reset returns the SAME empty array when it is already empty, or
  // the new reference would re-render every settings page that has no Tracearr.
  const hasTracearrInstance = tracearrInstances.length > 0;
  useEffect(() => {
    if (!hasTracearrInstance) return;
    // Async IIFE, not a bare call: the fetch sets its loading state before the
    // first await, and a setState running synchronously in an effect body is a
    // cascading render.
    void (async () => {
      await fetchTracearrImportStatus();
    })();
  }, [hasTracearrInstance, fetchTracearrImportStatus]);

  // Derived, never stored. With no Tracearr instance there is nothing to
  // report, and expressing that as a state RESET meant a synchronous setState
  // inside the effect above — a cascading render to say something the render
  // can simply compute. The module-level empty array keeps the reference stable
  // so a settings page with no Tracearr doesn't re-render on every pass.
  const visibleTracearrImportStatus = hasTracearrInstance
    ? tracearrImportStatus
    : NO_TRACEARR_IMPORT_STATUS;

  // Poll server data during active sync for real-time progress bar
  const hasActiveSync = servers.some(
    (s) => s.syncJobs[0]?.status === "RUNNING" || s.syncJobs[0]?.status === "PENDING"
  );
  // A running sync's progress, from the sync status rather than the server
  // list: `/api/servers` COUNTs MediaItem per library on every call, and a sync
  // announces progress every two seconds per server. Only the newest read is
  // applied, and only when no server list landed after it was asked for — that
  // list may already say the sync finished, which an older RUNNING row must
  // never undo.
  const progressRead = useRef(0);
  const fetchSyncProgress = useCallback(async () => {
    const seq = ++progressRead.current;
    const listsBefore = serversRead.current;
    const data = await fetchSyncStatus();
    if (!data?.jobs || seq !== progressRead.current || listsBefore !== serversRead.current) return;
    const jobs = data.jobs;
    setServers((current) => mergeSyncProgress(current, jobs));
  }, []);

  // Pushed. A sync starting, ending or a server changing re-reads the list;
  // progress in between only moves the running row (above).
  useRealtime("sync:started", fetchServers);
  useRealtime("sync:progress", fetchSyncProgress);
  useRealtime("sync:completed", fetchServers);
  useRealtime("sync:failed", fetchServers);
  useRealtime("server:changed", fetchServers);

  // The real-time connection line per server, under the toggle on General.
  // A connect or a drop is pushed (`server-status`, terminal states only); a
  // server added, removed or disabled changes the list.
  useRealtime("server-status", fetchRealtimeStatus);
  useRealtime("server:changed", fetchRealtimeStatus);
  const pollRealtimeStatus = activeTab === "general" && realtimeSync;
  useEffect(() => {
    if (!pollRealtimeStatus) return;
    const interval = setInterval(() => { void fetchRealtimeStatus(); }, REALTIME_STATUS_POLL_MS);
    return () => clearInterval(interval);
  }, [pollRealtimeStatus, fetchRealtimeStatus]);

  // The per-server "syncing" button state, reconciled against the pushed server
  // list during render. `fetchServers` also drops a settled request from state;
  // this covers the render in between.
  const activeSyncingServer = useMemo(
    () => (syncRequest && !isSyncRequestSettled(syncRequest, servers) ? syncRequest.serverId : null),
    [servers, syncRequest],
  );

  // Fallback only, for a dropped stream: it runs while pushes are not arriving
  // (`useFallbackPoll`), since with the stream up `sync:started`/`completed`/
  // `failed` re-read the list and a reconnect's resync covers a gap. Armed by
  // a pending request as well as by a job row: between pressing Sync and the
  // first refetch that sees the new row, `hasActiveSync` is still false, so
  // with the stream down nothing refetched at all and the button spun to its
  // 5-minute timeout.
  const pollServers = hasActiveSync || activeSyncingServer !== null;
  useFallbackPoll(() => { void fetchServers(); }, 15000, pollServers);

  // The import readout is PUSHED, not polled. The importer emits
  // `tracearr:import-progress` after each page commits (throttled there, since
  // it commits a page roughly every second across thousands), and this refetches
  // the status endpoint — which stays the single place the readout is computed,
  // so the event carries no figures to disagree with it.
  //
  // Polling was the wrong shape twice over: it moved on a fixed clock rather
  // than when anything changed, and it was gated on the backfill being
  // incomplete — so a forward-pass import on an already-backfilled server, which
  // is most syncs, updated nothing at all while the server rows beside it
  // refreshed every two seconds.
  useRealtime("tracearr:import-progress", () => {
    if (!hasTracearrInstance) return;
    void fetchTracearrImportStatus();
  });

  // Slow poll kept ONLY as the fallback for a dropped stream. SSE dies to proxy
  // buffering and idle timeouts, and the readout is the sole indication a
  // multi-hour archive walk is progressing — so it must not depend entirely on a
  // connection staying up. Deliberately slow: the push covers the live case, and
  // this only has to stop the number going stale for good. Runs while a backfill
  // is owed, which is the case that lasts long enough for a drop to matter.
  // Also while any import is live: a catch-up on an already-backfilled server
  // shows an import card too, and without this a dropped stream would leave
  // that card up until the next pushed event.
  const tracearrBackfillRunning = visibleTracearrImportStatus.some(
    (s) => !s.backfillComplete || s.activeImport !== null,
  );
  // Gated on the stream (`useFallbackPoll`): while pushes arrive, the
  // importer's own events already refetch.
  const pollTracearrImport = hasTracearrInstance && tracearrBackfillRunning;
  useFallbackPoll(() => { void fetchTracearrImportStatus(); }, TRACEARR_IMPORT_POLL_MS, pollTracearrImport);

  // ─── Server handlers ───

  const testAddServerConnection = async () => {
    if (!addServerDialog) return;
    setAddServerTesting(true);
    setAddServerTestResult(null);
    setAddServerError("");
    try {
      const res = await fetch("/api/servers/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: addServerForm.url,
          accessToken: addServerForm.apiKey,
          type: addServerDialog.type,
          tlsSkipVerify: addServerForm.tlsSkipVerify,
        }),
      });
      const data = await res.json();
      setAddServerTestResult({ ok: data.ok, error: data.error ?? undefined });
      if (data.ok && data.serverName) {
        setAddServerForm((f) => ({ ...f, name: data.serverName }));
      }
    } catch {
      setAddServerTestResult({ ok: false, error: "Network error" });
    } finally {
      setAddServerTesting(false);
    }
  };

  const addJellyfinEmbyServer = async () => {
    if (!addServerDialog) return;
    setAddServerSaving(true);
    setAddServerError("");
    try {
      const res = await fetch("/api/servers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: addServerForm.name || addServerDialog.type,
          url: addServerForm.url,
          accessToken: addServerForm.apiKey,
          type: addServerDialog.type,
          tlsSkipVerify: addServerForm.tlsSkipVerify,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setAddServerError(data.detail ? `${data.error} — ${data.detail}` : (data.error || "Failed to add server"));
        return;
      }

      // Fetch libraries for selection
      try {
        const libRes = await fetch(`/api/servers/${data.server.id}/libraries`);
        const libData = await libRes.json();
        const libs = (libData.libraries || []).map((lib: { key: string; title: string; type: string; enabled: boolean }) => ({
          ...lib,
          enabled: true,
        }));
        setAddServerDialog((prev) => prev ? {
          ...prev,
          step: "libraries",
          serverId: data.server.id,
          libraries: libs,
        } : null);
      } catch {
        // If library fetch fails, just close and sync all
        setAddServerDialog(null);
        await fetchServers();
        syncServer(data.server.id);
      }
    } catch {
      setAddServerError("Failed to add server");
    } finally {
      setAddServerSaving(false);
    }
  };

  const confirmAddServerLibraries = async () => {
    if (!addServerDialog?.serverId || !addServerDialog.libraries) return;
    setAddServerSaving(true);
    try {
      // Save library selections
      await fetch(`/api/servers/${addServerDialog.serverId}/libraries`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          libraries: addServerDialog.libraries.map((lib) => ({
            key: lib.key,
            enabled: lib.enabled,
          })),
        }),
      });

      // Trigger sync
      await fetch(`/api/servers/${addServerDialog.serverId}/sync`, { method: "POST" });

      setAddServerDialog(null);
      await fetchServers();
      toast.success("Server added", { description: "Syncing libraries now…" });
    } catch {
      setAddServerError("Failed to save library selections");
    } finally {
      setAddServerSaving(false);
    }
  };

  const syncServer = async (serverId: string, libraryKey?: string) => {
    const id = ++syncRequestSeq.current;
    setSyncRequest({ id, serverId, requestedAt: null });
    // Every exit ends THIS request only. Matching on the server id let the
    // first press's 5-minute timer cancel a second press on the same server,
    // and an error on one request cleared whichever request was current.
    const release = () => setSyncRequest((current) => (current?.id === id ? null : current));
    try {
      const res = await fetch(`/api/servers/${serverId}/sync`, {
        method: "POST",
        headers: libraryKey ? { "Content-Type": "application/json" } : undefined,
        body: libraryKey ? JSON.stringify({ libraryKey }) : undefined,
      });
      // A rejected request (disabled server, 409 from a race) enqueues nothing,
      // so no new job will ever appear to end this one. `fetch` does not throw
      // on a non-2xx, so without this the spinner runs to the 5-minute timeout.
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        toast.error(body?.error ?? "Failed to start sync");
        release();
        return;
      }
      const body = await res.json().catch(() => null);
      // The route always sends it; the client clock is only a fallback.
      const requestedAt: string =
        typeof body?.requestedAt === "string" ? body.requestedAt : new Date().toISOString();
      setSyncRequest((current) => (current?.id === id ? { ...current, requestedAt } : current));
      // A short sync can finish before this response is read, and the events
      // it sent were checked against a request that could not be matched yet.
      // One refetch now settles it rather than leaving the request stored.
      void fetchServers();
      // No completion poll here: `servers` is refreshed by the sync:*
      // subscriptions and the fallback poll above. The safety timeout stays so
      // the button cannot spin forever if every refresh is missed.
      setTimeout(release, 300000);
    } catch {
      toast.error("Failed to start sync");
      release();
    }
  };

  const syncAllServers = async () => {
    const enabledServers = servers.filter((s) => s.enabled);
    if (enabledServers.length === 0) return;
    try {
      const results = await Promise.allSettled(
        enabledServers.map((server) =>
          fetch(`/api/servers/${server.id}/sync`, { method: "POST" })
        )
      );
      const failed = results.filter(
        (r) => r.status === "rejected" || !r.value.ok
      ).length;
      if (failed > 0) {
        toast.error(`Failed to start sync for ${failed} of ${enabledServers.length} servers`);
      }
      await fetchServers();
    } catch {
      toast.error("Failed to start sync");
    }
  };

  const testServerConnection = async (serverId: string) => {
    setTestingServer(serverId);
    setTestResult(null);
    try {
      const res = await fetch(`/api/servers/${serverId}/test-connection`, { method: "POST" });
      const data = await res.json();
      setTestResult({ serverId, ok: data.ok, error: data.error ?? undefined });
    } catch {
      setTestResult({ serverId, ok: false, error: "Network error" });
    } finally {
      setTestingServer(null);
    }
  };

  const removeServer = async (deleteData: boolean) => {
    if (!removeServerDialog) return;
    setRemovingServer(true);
    try {
      const qs = deleteData ? "?deleteData=true" : "";
      const res = await fetch(`/api/servers/${removeServerDialog.serverId}${qs}`, { method: "DELETE" });
      if (!res.ok) {
        toast.error("Failed to remove server");
        return;
      }
      toast.success(`${removeServerDialog.serverName} removed`);
      setRemoveServerDialog(null);
      await fetchServers();
    } catch {
      toast.error("Failed to remove server");
    } finally {
      setRemovingServer(false);
    }
  };

  const startEditServer = async (server: MediaServer) => {
    setEditingServerId(server.id);
    setEditServerUrl(server.url);
    setEditServerExternalUrl((server as MediaServer & { externalUrl?: string | null }).externalUrl ?? "");
    setEditServerAccessToken("");
    setEditServerTlsSkip(server.tlsSkipVerify);
    setEditServerError("");

    // Fetch Plex connections for URL discovery
    if (server.machineId) {
      setLoadingPlexConnections(true);
      try {
        const response = await fetch("/api/auth/plex/servers");
        const data = await response.json();
        setPlexServers(data.servers || []);
      } catch {
        setPlexServers([]);
      } finally {
        setLoadingPlexConnections(false);
      }
    }
  };

  const saveServer = async (serverId: string) => {
    setEditServerSaving(true);
    setEditServerError("");
    try {
      // A new URL, or certificate checks turned off, for a server that keeps
      // its stored token or API key needs a recent sign-in (it would go to
      // whoever answers there).
      const response = await fetchWithReauth(`/api/servers/${serverId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: editServerUrl,
          externalUrl: editServerExternalUrl || null,
          ...(editServerAccessToken && { accessToken: editServerAccessToken }),
          tlsSkipVerify: editServerTlsSkip,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        setEditServerError(data.detail ? `${data.error} — ${data.detail}` : data.error);
        return;
      }
      setEditingServerId(null);
      setPlexServers([]);
      await fetchServers();
      toast.success("Server updated");
    } catch {
      setEditServerError("Failed to update server");
    } finally {
      setEditServerSaving(false);
    }
  };

  const toggleServerEnabled = async (serverId: string, enabled: boolean) => {
    if (!enabled) {
      const server = servers.find((s) => s.id === serverId);
      if (server) {
        setPurgeDialog({ open: true, mode: "server", serverId, serverName: server.name });
        return;
      }
    }
    try {
      const res = await fetch(`/api/servers/${serverId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      });
      if (res.ok) {
        await fetchServers();
        toast.success("Server enabled");
      } else {
        toast.error("Failed to enable server");
      }
    } catch (error) {
      console.error("Failed to enable server:", error);
      toast.error("Failed to enable server");
    }
  };

  /**
   * Writes the pending watch-history-source change from the confirm dialog.
   * `tracearrServerId: null` unlinks back to the media server's own history;
   * the route clears the server's stored `WatchHistory` either way, which is
   * what the dialog warned about, so the servers refetch afterwards keeps the
   * dropdown honest about what is actually stored.
   */
  // Resolves false when the change was refused, which keeps the dialog open.
  const confirmWatchHistorySource = async (): Promise<boolean> => {
    if (!watchHistorySourceDialog) return false;
    const { serverId, tracearrServerId, sourceLabel } = watchHistorySourceDialog;
    setSavingWatchHistorySource(serverId);
    try {
      const res = await fetch(`/api/servers/${serverId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tracearrServerId }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        toast.error("Failed to change watch history source", {
          description: data?.detail ?? data?.error,
        });
        return false;
      }
      setWatchHistorySourceDialog(null);
      // The PUT clears the stored history AND resets the backfill flag, so the
      // status line under the dropdown is stale the instant it returns —
      // refetch rather than leave a "fully imported" tick over an empty table.
      await Promise.all([fetchServers(), fetchTracearrImportStatus()]);
      toast.success("Watch history source changed", { description: `Now using ${sourceLabel}.` });
      return true;
    } catch (error) {
      console.error("Failed to change watch history source:", error);
      toast.error("Failed to change watch history source");
      return false;
    } finally {
      setSavingWatchHistorySource(null);
    }
  };

  const toggleLibrary = async (serverId: string, libraryKey: string, enabled: boolean) => {
    if (!enabled) {
      const server = servers.find((s) => s.id === serverId);
      const lib = server?.libraries.find((l) => l.key === libraryKey);
      if (lib) {
        const enabledOfType = servers.flatMap((s) => s.libraries)
          .filter((l) => l.type === lib.type && l.enabled);
        const isLastOfType = enabledOfType.length === 1 && enabledOfType[0].key === libraryKey;
        setPurgeDialog({
          open: true, mode: "library", serverId, libraryKey,
          libraryId: lib.id, libraryType: lib.type, isLastOfType,
        });
        return;
      }
    }
    await doToggleLibrary(serverId, libraryKey, enabled);
  };

  const doToggleLibrary = async (serverId: string, libraryKey: string, enabled: boolean) => {
    try {
      await fetch(`/api/servers/${serverId}/libraries`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ libraries: [{ key: libraryKey, enabled }] }),
      });
      await fetchServers();
      if (enabled) {
        setSyncPrompt({ open: true, serverId, libraryKey });
      }
    } catch (error) {
      console.error("Failed to toggle library:", error);
    }
  };

  const refreshLibraries = async (serverId: string) => {
    setRefreshingLibraries(serverId);
    try {
      const res = await fetch(`/api/servers/${serverId}/libraries`);
      if (res.ok) {
        const data = await res.json();
        const remoteLibs: { key: string; title: string; type: string; enabled: boolean; exists: boolean }[] = data.libraries || [];
        // Save any new libraries (enabled by default)
        const newLibs = remoteLibs.filter((l) => !l.exists);
        if (newLibs.length > 0) {
          await fetch(`/api/servers/${serverId}/libraries`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ libraries: newLibs.map((l) => ({ key: l.key, enabled: l.enabled })) }),
          });
        }
        await fetchServers();
      }
    } catch (error) {
      console.error("Failed to refresh libraries:", error);
    } finally {
      setRefreshingLibraries(null);
    }
  };

  const handlePurgeConfirm = async (deleteData: boolean) => {
    if (!purgeDialog) return;
    setPurging(true);
    try {
      if (purgeDialog.mode === "library") {
        await doToggleLibrary(purgeDialog.serverId, purgeDialog.libraryKey!, false);
        if (deleteData && purgeDialog.libraryId) {
          await fetch(`/api/media/purge?libraryId=${purgeDialog.libraryId}`, {
            method: "DELETE",
          });
        }
        toast.success("Library disabled", deleteData ? { description: "Media data removed." } : undefined);
      } else {
        const res = await fetch(`/api/servers/${purgeDialog.serverId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: false, deleteData }),
        });
        if (res.ok) {
          await fetchServers();
          toast.success("Server disabled", deleteData ? { description: "Media data removed." } : undefined);
        } else {
          toast.error("Failed to disable server");
        }
      }
    } catch (error) {
      console.error("Failed to disable:", error);
      toast.error("Failed to disable");
    } finally {
      setPurging(false);
      setPurgeDialog(null);
    }
  };

  // ─── Schedule handlers ───

  const handleScheduledJobTimeChange = async (value: string) => {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
      setScheduledJobTime(value);
      return;
    }
    setScheduledJobTime(value);
    setSavingJobTime(true);
    try {
      const res = await fetch("/api/settings/scheduled-job-time", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scheduledJobTime: value }),
      });
      if (!res.ok) {
        toast.error("Failed to save scheduled job time");
      } else {
        toast.success("Scheduled job time saved");
      }
      fetchScheduleInfo();
    } catch {
      toast.error("Failed to save scheduled job time");
    } finally {
      setSavingJobTime(false);
    }
  };

  const handleRunNow = async (job: "sync" | "detection" | "execution") => {
    setRunningJob(job);
    try {
      const res = await fetch("/api/settings/schedule-info/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ job }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        toast.error("Failed to start job", { description: data?.error });
      } else {
        const label = job === "sync" ? "Sync" : job === "detection" ? "Detection" : "Execution";
        toast.success(`${label} started`);
      }
      // Refresh schedule info + sync status after completion
      fetchScheduleInfo();
      if (job === "sync") fetchServers();
    } catch {
      toast.error("Failed to start job");
    } finally {
      setRunningJob(null);
    }
  };

  // ─── General tab handlers ───

  const saveAccentColor = async (name: string) => {
    setAccentColor(name);
    window.dispatchEvent(new CustomEvent("accent-color-changed", { detail: name }));
    try {
      const res = await fetch("/api/settings/accent-color", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accentColor: name }),
      });
      if (!res.ok) toast.error("Failed to save accent color");
    } catch {
      toast.error("Failed to save accent color");
    }
  };

  const saveChipColor = async (category: ChipColorCategory, key: string, hex: string) => {
    const updated: ChipColorMap = {
      ...chipColors,
      [category]: { ...chipColors[category], [key]: hex },
    };
    setChipColors(updated);
    updateChipColorContext(updated);
    try {
      const res = await fetch("/api/settings/chip-colors", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chipColors: updated }),
      });
      if (!res.ok) toast.error("Failed to save chip colors");
    } catch {
      toast.error("Failed to save chip colors");
    }
  };

  const resetChipColors = async () => {
    setChipColors(DEFAULT_CHIP_COLORS);
    updateChipColorContext(DEFAULT_CHIP_COLORS);
    try {
      const res = await fetch("/api/settings/chip-colors", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chipColors: DEFAULT_CHIP_COLORS }),
      });
      if (!res.ok) toast.error("Failed to reset chip colors");
    } catch {
      toast.error("Failed to reset chip colors");
    }
  };

  const saveDedupSetting = async (value: boolean) => {
    setSavingDedup(true);
    try {
      const res = await fetch("/api/settings/dedup", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dedupStats: value }),
      });
      if (!res.ok) {
        toast.error("Failed to save deduplication setting");
        return;
      }
      setDedupStats(value);
      toast.success("Deduplication setting saved");
    } catch {
      toast.error("Failed to save deduplication setting");
    } finally {
      setSavingDedup(false);
    }
  };

  const saveRealtimeSetting = async (value: boolean) => {
    setSavingRealtime(true);
    try {
      const res = await fetch("/api/settings/realtime", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ realtimeSync: value }),
      });
      if (!res.ok) {
        toast.error("Failed to save real-time sync setting");
        return;
      }
      setRealtimeSync(value);
      void fetchRealtimeStatus();
      toast.success(value ? "Real-time sync enabled" : "Real-time sync disabled");
    } catch {
      toast.error("Failed to save real-time sync setting");
    } finally {
      setSavingRealtime(false);
    }
  };

  const saveLogRetention = async () => {
    const days = parseInt(logRetentionInput);
    if (isNaN(days) || days < 1 || days > 365) return;
    setSavingLogRetention(true);
    try {
      const response = await fetch("/api/settings/log-retention", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ logRetentionDays: days }),
      });
      if (response.ok) {
        setLogRetentionDays(days);
        toast.success("Log retention saved");
      } else {
        toast.error("Failed to save log retention");
      }
    } catch {
      toast.error("Failed to save log retention");
    } finally {
      setSavingLogRetention(false);
    }
  };

  const saveActionRetention = async () => {
    const days = parseInt(actionRetentionInput);
    if (isNaN(days) || days < 0 || days > 365) return;
    setSavingActionRetention(true);
    try {
      const response = await fetch("/api/settings/action-retention", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actionHistoryRetentionDays: days }),
      });
      if (response.ok) {
        setActionRetentionDays(days);
        toast.success("Action history retention saved");
      } else {
        toast.error("Failed to save action history retention");
      }
    } catch {
      toast.error("Failed to save action history retention");
    } finally {
      setSavingActionRetention(false);
    }
  };

  const savePreferredTitleServer = async (value: string) => {
    const newServerId = value === "none" ? null : value;
    setPreferredTitleServerId(newServerId);
    try {
      const res = await fetch("/api/settings/title-preference", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serverId: newServerId, field: "title" }),
      });
      if (!res.ok) toast.error("Failed to save title preference");
      else toast.success("Title preference saved");
    } catch {
      toast.error("Failed to save title preference");
    }
  };

  const savePreferredArtworkServer = async (value: string) => {
    const newServerId = value === "none" ? null : value;
    setPreferredArtworkServerId(newServerId);
    try {
      const res = await fetch("/api/settings/title-preference", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serverId: newServerId, field: "artwork" }),
      });
      if (!res.ok) toast.error("Failed to save artwork preference");
      else toast.success("Artwork preference saved");
    } catch {
      toast.error("Failed to save artwork preference");
    }
  };

  const handleBackupScheduleChange = async (value: string) => {
    setBackupSchedule(value);
    setBackupSaving(true);
    try {
      const res = await fetch("/api/settings/backup-schedule", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ backupSchedule: value }),
      });
      if (!res.ok) toast.error("Failed to save backup schedule");
      else toast.success("Backup schedule saved");
    } catch {
      toast.error("Failed to save backup schedule");
    } finally {
      setBackupSaving(false);
    }
  };

  const handleSaveBackupRetention = async () => {
    setBackupSaving(true);
    try {
      const res = await fetch("/api/settings/backup-schedule", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ backupRetentionCount }),
      });
      if (!res.ok) toast.error("Failed to save backup retention");
      else toast.success("Backup retention saved");
    } catch {
      toast.error("Failed to save backup retention");
    } finally {
      setBackupSaving(false);
    }
  };

  // Creating, downloading and restoring a backup need a sign-in from the last
  // 15 minutes (a backup holds the Plex token); `fetchWithReauth` asks the user
  // to confirm it's them and repeats the request.
  const handleCreateBackup = async (includeMediaData = false) => {
    setCreatingBackup(true);
    try {
      const res = await fetchWithReauth("/api/backup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ includeMediaData }),
      });
      if (res.ok) {
        toast.success("Backup created");
        await fetchBackupSettings();
      } else {
        const data = await res.json().catch(() => null);
        toast.error("Failed to create backup", { description: data?.error });
      }
    } catch {
      toast.error("Failed to create backup");
    } finally {
      setCreatingBackup(false);
    }
  };

  const handleSaveBackupPassword = async (password: string | null) => {
    setSavingBackupPassword(true);
    try {
      const res = await fetch("/api/settings/backup-encryption-password", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ backupEncryptionPassword: password }),
      });
      if (res.ok) {
        const data = await res.json();
        setHasBackupPassword(data.hasPassword);
        toast.success(password ? "Encryption password saved" : "Encryption password removed");
      } else {
        toast.error("Failed to save encryption password");
      }
    } catch {
      toast.error("Failed to save encryption password");
    } finally {
      setSavingBackupPassword(false);
    }
  };

  // Fetched rather than opened in a tab: a plain navigation cannot show the
  // "Confirm it's you" prompt, so a refused download would open the 403 JSON.
  const handleDownloadBackup = async (filename: string) => {
    // One at a time per file: its button stays disabled until this one ends.
    if (downloadingBackups.includes(filename)) return;
    setDownloadingBackups((current) => [...current, filename]);
    try {
      const res = await fetchWithReauth(`/api/backup/${encodeURIComponent(filename)}`);
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        toast.error("Failed to download backup", { description: data?.error });
        return;
      }
      const url = URL.createObjectURL(await res.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      // Revoking at once can cancel the download before the browser has read
      // the blob; FileSaver.js waits 40 seconds for the same reason.
      setTimeout(() => URL.revokeObjectURL(url), 40_000);
    } catch {
      toast.error("Failed to download backup");
    } finally {
      // Only this download's spinner: others may still be running.
      setDownloadingBackups((current) => current.filter((f) => f !== filename));
    }
  };

  // Confirmation happens in the GeneralTab restore dialog before this is called.
  const handleRestoreBackup = async (filename: string, passphrase?: string) => {
    setRestoringBackup(filename);
    setRestoreProgress(null);
    try {
      const res = await fetchWithReauth("/api/backup/restore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename, ...(passphrase ? { passphrase } : {}) }),
      });
      if (!res.ok) {
        // Refused before the stream started: a JSON error, not progress lines.
        const data = await res.json().catch(() => null);
        toast.error("Restore failed", { description: data?.error });
        return;
      }
      if (!res.body) {
        toast.error("Restore failed", { description: "The server returned an empty response." });
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let lastError: string | null = null;
      let completed = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            if (event.type === "progress") {
              setRestoreProgress(event.message);
            } else if (event.type === "complete") {
              completed = true;
            } else if (event.type === "error") {
              lastError = event.message;
            }
          } catch { /* ignore malformed lines */ }
        }
      }

      if (completed) {
        window.location.href = "/login";
      } else {
        toast.error("Restore failed", { description: lastError || undefined });
      }
    } catch {
      toast.error("Restore failed", { description: "Network error while restoring the backup." });
    } finally {
      setRestoringBackup(null);
      setRestoreProgress(null);
    }
  };

  // Confirmation happens in the GeneralTab delete dialog before this is called.
  const handleDeleteBackup = async (filename: string) => {
    try {
      const res = await fetch(`/api/backup/${encodeURIComponent(filename)}`, { method: "DELETE" });
      if (!res.ok) {
        toast.error("Failed to delete backup");
        return;
      }
      toast.success("Backup deleted");
      await fetchBackupSettings();
    } catch {
      toast.error("Failed to delete backup");
    }
  };

  // ─── Notification handlers ───

  const saveDiscordSettings = async () => {
    setDiscordSaving(true);
    setDiscordTestResult(null);
    try {
      const res = await fetch("/api/settings/discord", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          webhookUrl: discordWebhookUrl,
          webhookUsername: discordWebhookUsername,
          webhookAvatarUrl: discordWebhookAvatarUrl,
          notifyApiKeys: discordNotifyApiKeys,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        const detail = data?.details?.[0]?.message ?? data?.detail;
        toast.error("Failed to save notification settings", { description: detail ?? data?.error });
        return;
      }
      toast.success("Notification settings saved");
    } catch (error) {
      console.error("Failed to save Discord settings:", error);
      toast.error("Failed to save notification settings");
    } finally {
      setDiscordSaving(false);
    }
  };

  const testDiscordWebhook = async () => {
    setDiscordTesting(true);
    setDiscordTestResult(null);
    try {
      const response = await fetch("/api/settings/discord/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          webhookUrl: discordWebhookUrl,
          webhookUsername: discordWebhookUsername,
          webhookAvatarUrl: discordWebhookAvatarUrl,
        }),
      });
      const data = await response.json();
      if (data.success) {
        setDiscordTestResult({ ok: true });
        toast.success("Test notification sent", { description: "Check your Discord channel." });
      } else {
        setDiscordTestResult({ ok: false, error: data.error || "Test failed" });
        toast.error("Test notification failed", { description: data.error });
      }
    } catch (error) {
      setDiscordTestResult({ ok: false, error: "Request failed" });
      console.error("Failed to test Discord webhook:", error);
      toast.error("Test notification failed");
    } finally {
      setDiscordTesting(false);
    }
  };

  // ─── AI assistant handlers ───

  const saveAiSettings = async () => {
    setAiSaving(true);
    setAiTestResult(null);
    try {
      const res = await fetchWithReauth("/api/settings/ai", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: aiEnabled,
          provider: aiProvider,
          baseUrl: aiBaseUrl,
          apiKey: aiApiKey,
          model: aiModel,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        // Validation details are strings ("baseUrl: Invalid URL"), as the
        // integration forms read them.
        toast.error("Failed to save AI settings", { description: integrationSaveError(data, "Save failed") });
        return;
      }
      const data = await res.json();
      // Reflect the masked key returned by the server so the field shows saved state.
      setAiApiKey(data.apiKey ?? "");
      toast.success("AI settings saved");
    } catch (error) {
      console.error("Failed to save AI settings:", error);
      toast.error("Failed to save AI settings");
    } finally {
      setAiSaving(false);
    }
  };

  const testAiConnection = async () => {
    setAiTesting(true);
    setAiTestResult(null);
    try {
      const res = await fetchWithReauth("/api/settings/ai/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: aiProvider,
          baseUrl: aiBaseUrl,
          apiKey: aiApiKey,
          model: aiModel,
        }),
      });
      const data = await res.json();
      if (data.ok) {
        setAiTestResult({ ok: true });
        toast.success("AI connection successful");
      } else {
        setAiTestResult({ ok: false, error: data.error || "Connection failed" });
        toast.error("AI connection failed", { description: data.error });
      }
    } catch (error) {
      setAiTestResult({ ok: false, error: "Request failed" });
      console.error("Failed to test AI connection:", error);
      toast.error("AI connection failed");
    } finally {
      setAiTesting(false);
    }
  };

  // ─── Authentication handlers ───

  const handlePlexLink = () => plexOAuth.startAuth();

  // After an SSO change: whether SSO is usable decides whether the password is
  // accepted at all (passwordSignInEnabled), and with it whether the forms
  // here ask for the current password.
  const refreshAuthInfo = useCallback(() => {
    void fetchAuthInfo();
  }, [fetchAuthInfo]);

  const handleToggleLocalAuth = async (checked: boolean) => {
    setLocalAuthError("");
    // If enabling and no credentials exist, prompt to create them first
    if (checked && !authInfo?.hasPassword) {
      setPromptForm({ username: "", password: "", confirmPassword: "" });
      setPromptError("");
      setShowCredentialPrompt(true);
      return;
    }
    setAuthLoading(true);
    try {
      // Turning local login on gives the password its power back, which needs
      // a recent sign-in by another method.
      const res = await fetchWithReauth("/api/settings/auth", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ localAuthEnabled: checked }),
      });
      if (res.ok) {
        setAuthInfo((prev) => prev ? { ...prev, localAuthEnabled: checked } : prev);
        // Whether the password is now accepted also depends on SSO: re-read it.
        const infoRes = await bundleOf(bundleRef).get("/api/settings/auth");
        if (infoRes.ok) setAuthInfo(await infoRes.json());
        toast.success(checked ? "Local login enabled" : "Local login disabled");
      } else {
        // Surface the lockout-guard error inline. The UI also gates the
        // switch via wouldLockOut, so this mostly catches edge cases where
        // the client state is stale (e.g. SSO became unlinked from another
        // tab between page load and clicking the toggle).
        const data = await res.json().catch(() => ({}));
        setLocalAuthError(data.error || "Failed to update local login setting");
      }
    } catch {
      setLocalAuthError("Network error");
    } finally {
      setAuthLoading(false);
    }
  };

  const handleTogglePlexLogin = async (checked: boolean) => {
    setPlexLoginError("");
    setAuthLoading(true);
    try {
      // Turning Plex login on lets whoever holds the Plex account sign in,
      // which needs a recent sign-in by another method.
      const res = await fetchWithReauth("/api/settings/auth", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plexLoginEnabled: checked }),
      });
      if (res.ok) {
        setAuthInfo((prev) => prev ? { ...prev, plexLoginEnabled: checked } : prev);
        toast.success(checked ? "Plex login enabled" : "Plex login disabled");
      } else {
        // Surface the lockout-guard error inline in the Plex Connection card.
        const data = await res.json().catch(() => ({}));
        setPlexLoginError(data.error || "Failed to update Plex login setting");
      }
    } catch {
      setPlexLoginError("Network error");
    } finally {
      setAuthLoading(false);
    }
  };

  const handleChangeCredentials = async () => {
    setCredentialsError("");
    setCredentialsSuccess("");

    if (credentialsForm.newPassword && credentialsForm.newPassword !== credentialsForm.confirmPassword) {
      setCredentialsError("Passwords do not match");
      return;
    }
    const newPasswordIssue = credentialsForm.newPassword ? newPasswordProblem(credentialsForm.newPassword) : null;
    if (newPasswordIssue) {
      setCredentialsError(newPasswordIssue);
      return;
    }

    setCredentialsSaving(true);
    try {
      // Sent only when the form asked for it (password sign-in on); otherwise
      // the server wants a recent sign-in, which fetchWithReauth prompts for.
      const body: Record<string, string> = {};
      if (credentialsForm.currentPassword) body.currentPassword = credentialsForm.currentPassword;
      if (credentialsForm.newPassword) body.newPassword = credentialsForm.newPassword;
      if (credentialsForm.newUsername) body.newUsername = credentialsForm.newUsername;

      const res = await fetchWithReauth("/api/auth/local/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();

      if (!res.ok) {
        setCredentialsError(data.error || "Failed to update credentials");
        return;
      }

      setCredentialsSuccess("Credentials updated successfully");
      toast.success("Credentials updated");
      setCredentialsForm({ currentPassword: "", newUsername: "", newPassword: "", confirmPassword: "" });
      // Refresh auth info to show updated username
      const infoRes = await bundleOf(bundleRef).get("/api/settings/auth");
      if (infoRes.ok) setAuthInfo(await infoRes.json());
    } catch {
      setCredentialsError("Network error");
    } finally {
      setCredentialsSaving(false);
    }
  };

  const handleCreateCredentialsAndEnable = async () => {
    setPromptError("");
    if (promptForm.username.trim().length < 3) {
      setPromptError("Username must be at least 3 characters");
      return;
    }
    const passwordProblem = newPasswordProblem(promptForm.password);
    if (passwordProblem) {
      setPromptError(passwordProblem);
      return;
    }
    if (promptForm.password !== promptForm.confirmPassword) {
      setPromptError("Passwords do not match");
      return;
    }
    setPromptSaving(true);
    try {
      // Create credentials
      const credRes = await fetchWithReauth("/api/auth/local/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          newUsername: promptForm.username.trim(),
          newPassword: promptForm.password,
        }),
      });
      if (!credRes.ok) {
        const data = await credRes.json();
        setPromptError(data.error || "Failed to create credentials");
        return;
      }
      // Enable local auth (needs a recent sign-in, like the first password)
      const authRes = await fetchWithReauth("/api/settings/auth", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ localAuthEnabled: true }),
      });
      if (authRes.ok) {
        // Refresh auth info
        const infoRes = await bundleOf(bundleRef).get("/api/settings/auth");
        if (infoRes.ok) setAuthInfo(await infoRes.json());
      }
      setShowCredentialPrompt(false);
    } catch {
      setPromptError("Network error");
    } finally {
      setPromptSaving(false);
    }
  };

  // ─── System handlers ───

  // Confirmation happens in the SystemTab dialog before this is called.
  const handleClearImageCache = async () => {
    setClearingImageCache(true);
    try {
      const res = await fetch("/api/settings/image-cache", { method: "DELETE" });
      if (!res.ok) {
        toast.error("Failed to clear image cache");
        return;
      }
      toast.success("Image cache cleared");
      await fetchImageCacheStats();
    } catch {
      toast.error("Failed to clear image cache");
    } finally {
      setClearingImageCache(false);
    }
  };

  // ─── Loading gate ───

  if (!hydrated) {
    return <SettingsSkeleton />;
  }

  // ─── Render ───

  return (
    <div className="p-4 sm:p-6 lg:p-8">
      <div className="mb-6">
        <h1 className="text-2xl sm:text-3xl font-bold font-display tracking-tight">Settings</h1>
        <p className="text-muted-foreground mt-1">
          Manage servers, integrations, schedules, and application preferences.
        </p>
      </div>

      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as SettingsTab)}>
        <div className="flex flex-col gap-6 lg:flex-row lg:gap-8">
          <aside className="min-w-0 shrink-0 lg:self-start lg:sticky lg:top-6 lg:w-[216px]">
            <SettingsSubNav
              activeTab={activeTab}
              onTabChange={setActiveTab}
              updateAvailable={updateCheck?.updateAvailable}
              latestVersion={updateCheck?.latestVersion}
            />
          </aside>
          <div className="min-w-0 flex-1 space-y-6">
        <TabsContent value="general" id="settings-panel-general" aria-labelledby="settings-tab-general">
          {loadedTabs.has("general") ? (
            <GeneralTab
              accentColor={accentColor}
              onSaveAccentColor={saveAccentColor}
              chipColors={chipColors}
              onSaveChipColor={saveChipColor}
              onResetChipColors={resetChipColors}
              dedupStats={dedupStats}
              savingDedup={savingDedup}
              onSaveDedupSetting={saveDedupSetting}
              realtimeSync={realtimeSync}
              savingRealtime={savingRealtime}
              onSaveRealtimeSetting={saveRealtimeSetting}
              realtimeServers={realtimeServers}
              logRetentionDays={logRetentionDays}
              logRetentionInput={logRetentionInput}
              savingLogRetention={savingLogRetention}
              onLogRetentionInputChange={setLogRetentionInput}
              onSaveLogRetention={saveLogRetention}
              actionRetentionDays={actionRetentionDays}
              actionRetentionInput={actionRetentionInput}
              savingActionRetention={savingActionRetention}
              onActionRetentionInputChange={setActionRetentionInput}
              onSaveActionRetention={saveActionRetention}
            deleteCeilingInput={deleteCeilingInput}
            savedDeleteCeiling={savedDeleteCeiling}
            savingDeleteCeiling={savingDeleteCeiling}
            onDeleteCeilingInputChange={setDeleteCeilingInput}
            onSaveDeleteCeiling={saveDeleteCeiling}
              backupSchedule={backupSchedule}
              backupRetentionCount={backupRetentionCount}
              backups={backups}
              backupLoading={backupLoading}
              backupSaving={backupSaving}
              creatingBackup={creatingBackup}
              restoringBackup={restoringBackup}
              downloadingBackups={downloadingBackups}
              restoreProgress={restoreProgress}
              hasBackupPassword={hasBackupPassword}
              savingBackupPassword={savingBackupPassword}
              onBackupScheduleChange={handleBackupScheduleChange}
              onBackupRetentionCountChange={setBackupRetentionCount}
              onSaveBackupRetention={handleSaveBackupRetention}
              onSaveBackupPassword={handleSaveBackupPassword}
              onCreateBackup={handleCreateBackup}
              onDownloadBackup={handleDownloadBackup}
              onRestoreBackup={handleRestoreBackup}
              onDeleteBackup={handleDeleteBackup}
              servers={servers}
              preferredTitleServerId={preferredTitleServerId}
              preferredArtworkServerId={preferredArtworkServerId}
              onSavePreferredTitleServer={savePreferredTitleServer}
              onSavePreferredArtworkServer={savePreferredArtworkServer}
            />
          ) : (
            <SettingsPanelSkeleton />
          )}
        </TabsContent>

        <TabsContent value="scheduling" id="settings-panel-scheduling" aria-labelledby="settings-tab-scheduling">
          {loadedTabs.has("scheduling") ? (
            <SchedulingTab
              scheduledJobTime={scheduledJobTime}
              savingJobTime={savingJobTime}
              onScheduledJobTimeChange={handleScheduledJobTimeChange}
              syncSchedule={syncSchedule}
              lastScheduledSync={lastScheduledSync}
              detectionSchedule={detectionSchedule}
              lastLcDetect={lastLcDetect}
              executionSchedule={executionSchedule}
              lastLcExec={lastLcExec}
              timezone={scheduleInfo?.timezone ?? null}
              scheduleInfo={scheduleInfo}
              runningJob={runningJob}
              onRunNow={handleRunNow}
            />
          ) : (
            <SettingsPanelSkeleton />
          )}
        </TabsContent>

        <TabsContent value="servers" id="settings-panel-servers" aria-labelledby="settings-tab-servers">
          {loadedTabs.has("servers") ? (
            <ServersTab
              servers={servers}
              hasActiveSync={hasActiveSync}
              syncingServer={activeSyncingServer}
              testingServer={testingServer}
              testResult={testResult}
              refreshingLibraries={refreshingLibraries}
              addServerDialog={addServerDialog}
              addServerForm={addServerForm}
              addServerSaving={addServerSaving}
              addServerError={addServerError}
              addServerTesting={addServerTesting}
              addServerTestResult={addServerTestResult}
              plexLinking={plexLinking}
              authInfo={authInfo}
              editingServerId={editingServerId}
              editServerUrl={editServerUrl}
              editServerExternalUrl={editServerExternalUrl}
              editServerAccessToken={editServerAccessToken}
              editServerTlsSkip={editServerTlsSkip}
              editServerSaving={editServerSaving}
              editServerError={editServerError}
              plexServers={plexServers}
              loadingPlexConnections={loadingPlexConnections}
              purgeDialog={purgeDialog}
              purging={purging}
              syncPrompt={syncPrompt}
              removeServerDialog={removeServerDialog}
              removingServer={removingServer}
              tracearrInstances={tracearrInstances}
              tracearrServerLists={tracearrServerLists}
              tracearrImportStatus={visibleTracearrImportStatus}
              watchHistorySourceDialog={watchHistorySourceDialog}
              savingWatchHistorySource={savingWatchHistorySource}
              setAddServerDialog={setAddServerDialog}
              setAddServerForm={setAddServerForm}
              setAddServerError={setAddServerError}
              setAddServerTestResult={setAddServerTestResult}
              onStartPlexOAuth={plexOAuthForOnboarding.startAuth}
              onCancelPlexOAuth={plexOAuthForOnboarding.cancel}
              setEditingServerId={setEditingServerId}
              setEditServerUrl={setEditServerUrl}
              setEditServerExternalUrl={setEditServerExternalUrl}
              setEditServerAccessToken={setEditServerAccessToken}
              setEditServerTlsSkip={setEditServerTlsSkip}
              setEditServerError={setEditServerError}
              setPlexServers={setPlexServers}
              setPurgeDialog={setPurgeDialog}
              setSyncPrompt={setSyncPrompt}
              setRemoveServerDialog={setRemoveServerDialog}
              setWatchHistorySourceDialog={setWatchHistorySourceDialog}
              onSyncServer={syncServer}
              onSyncAllServers={syncAllServers}
              onTestServerConnection={testServerConnection}
              onRemoveServer={removeServer}
              onStartEditServer={startEditServer}
              onSaveServer={saveServer}
              onToggleLibrary={toggleLibrary}
              onRefreshLibraries={refreshLibraries}
              onHandlePurgeConfirm={handlePurgeConfirm}
              onTestAddServerConnection={testAddServerConnection}
              onAddJellyfinEmbyServer={addJellyfinEmbyServer}
              onConfirmAddServerLibraries={confirmAddServerLibraries}
              onToggleServerEnabled={toggleServerEnabled}
              onConfirmWatchHistorySource={confirmWatchHistorySource}
            />
          ) : (
            <SettingsPanelSkeleton />
          )}
        </TabsContent>

        {/* Kept mounted (hidden) once opened: the forms hold their own state
            (useIntegrationInstances), which a switch to another tab would
            otherwise drop mid-edit. */}
        <TabsContent
          value="integrations"
          id="settings-panel-integrations"
          aria-labelledby="settings-tab-integrations"
          forceMount={integrationsOpened || undefined}
          className="data-[state=inactive]:hidden"
        >
          {loadedTabs.has("integrations") ? (
            <IntegrationsTab
              instances={integrationInstances}
              onRefresh={fetchIntegrationInstances}
              onTracearrUpdated={fetchTracearrServers}
            />
          ) : (
            <SettingsPanelSkeleton />
          )}
        </TabsContent>

        <TabsContent value="notifications" id="settings-panel-notifications" aria-labelledby="settings-tab-notifications">
          {loadedTabs.has("notifications") ? (
            <NotificationsTab
              discordWebhookUrl={discordWebhookUrl}
              discordWebhookUsername={discordWebhookUsername}
              discordWebhookAvatarUrl={discordWebhookAvatarUrl}
              discordNotifyApiKeys={discordNotifyApiKeys}
              discordSaving={discordSaving}
              discordTesting={discordTesting}
              discordTestResult={discordTestResult}
              onDiscordWebhookUrlChange={setDiscordWebhookUrl}
              onDiscordWebhookUsernameChange={setDiscordWebhookUsername}
              onDiscordWebhookAvatarUrlChange={setDiscordWebhookAvatarUrl}
              onDiscordNotifyApiKeysChange={setDiscordNotifyApiKeys}
              onSaveDiscordSettings={saveDiscordSettings}
              onTestDiscordWebhook={testDiscordWebhook}
            />
          ) : (
            <SettingsPanelSkeleton />
          )}
        </TabsContent>

        <TabsContent value="authentication" id="settings-panel-authentication" aria-labelledby="settings-tab-authentication">
          {loadedTabs.has("authentication") ? (
            <AuthenticationTab
              authInfo={authInfo}
              authLoading={authLoading}
              plexLinking={plexLinking}
              credentialsForm={credentialsForm}
              credentialsSaving={credentialsSaving}
              credentialsError={credentialsError}
              credentialsSuccess={credentialsSuccess}
              plexLoginError={plexLoginError}
              localAuthError={localAuthError}
              showCredentialPrompt={showCredentialPrompt}
              promptForm={promptForm}
              promptError={promptError}
              promptSaving={promptSaving}
              onSetCredentialsForm={setCredentialsForm}
              onSetPromptForm={setPromptForm}
              onSetShowCredentialPrompt={setShowCredentialPrompt}
              onToggleLocalAuth={handleToggleLocalAuth}
              onTogglePlexLogin={handleTogglePlexLogin}
              onChangeCredentials={handleChangeCredentials}
              onPlexLink={handlePlexLink}
              onCreateCredentialsAndEnable={handleCreateCredentialsAndEnable}
              onAuthSettingsChanged={refreshAuthInfo}
              readSectionData={readAuthSectionData}
            />
          ) : (
            <SettingsPanelSkeleton />
          )}
        </TabsContent>

        <TabsContent value="ai" id="settings-panel-ai" aria-labelledby="settings-tab-ai">
          {loadedTabs.has("ai") ? (
            <AiTab
              aiEnabled={aiEnabled}
              aiProvider={aiProvider}
              aiBaseUrl={aiBaseUrl}
              aiApiKey={aiApiKey}
              aiModel={aiModel}
              aiSaving={aiSaving}
              aiTesting={aiTesting}
              aiTestResult={aiTestResult}
              onAiEnabledChange={setAiEnabled}
              onAiProviderChange={setAiProvider}
              onAiBaseUrlChange={setAiBaseUrl}
              onAiApiKeyChange={setAiApiKey}
              onAiModelChange={setAiModel}
              onSaveAiSettings={saveAiSettings}
              onTestAiConnection={testAiConnection}
            />
          ) : (
            <SettingsPanelSkeleton />
          )}
        </TabsContent>

        <TabsContent value="system" id="settings-panel-system" aria-labelledby="settings-tab-system">
          {loadedTabs.has("system") ? (
            <SystemTab
              systemInfo={systemInfo}
              updateCheck={updateCheck}
              imageCacheStats={imageCacheStats}
              clearingImageCache={clearingImageCache}
              onClearImageCache={handleClearImageCache}
              releaseNotes={releaseNotes}
              loadingChangelog={loadingChangelog}
            />
          ) : (
            <SettingsPanelSkeleton />
          )}
        </TabsContent>
          </div>
        </div>
      </Tabs>

      <PlexLoginPrompt
        open={plexLoginPrompt !== null}
        onDone={(enabled) => {
          const then = plexLoginPrompt?.then ?? null;
          setPlexLoginPrompt(null);
          if (enabled) setAuthInfo((prev) => (prev ? { ...prev, plexLoginEnabled: true } : prev));
          if (then) window.location.assign(then);
        }}
      />
    </div>
  );
}
