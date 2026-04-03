"use client";

import { useState, useEffect, useCallback } from "react";
import { usePlexOAuth } from "@/hooks/use-plex-oauth";
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
} from "lucide-react";
import { TabNav, type TabNavItem } from "@/components/tab-nav";
import { SettingsSkeleton } from "@/components/skeletons";

// ─── Tab components ───
import { GeneralTab } from "./tabs/general-tab";
import { SchedulingTab } from "./tabs/scheduling-tab";
import { ServersTab } from "./tabs/servers-tab";
import type { AddServerDialogState, AddServerFormState, PurgeDialogState, SyncPromptState, RemoveServerDialogState, ServerTestResult } from "./tabs/servers-tab";
import { IntegrationsTab } from "./tabs/integrations-tab";
import { NotificationsTab } from "./tabs/notifications-tab";
import { AuthenticationTab } from "./tabs/authentication-tab";
import type { CredentialsForm, PromptForm } from "./tabs/authentication-tab";
import { SystemTab } from "./tabs/system-tab";

// ─── Shared types ───
import type {
  MediaServer,
  ArrInstance,
  SeerrInstance,
  PlexServer,
  ScheduleInfo,
  AuthInfo,
  SystemInfo,
  ImageCacheStats,
  TestResult,
  BackupEntry,
  ReleaseNote,
} from "./types";
import { PRESET_VALUES } from "./types";

// ─── Tab navigation ───

type SettingsTab = "general" | "scheduling" | "servers" | "integrations" | "notifications" | "authentication" | "system";

const SETTINGS_TABS: { value: SettingsTab; label: string; icon: typeof SettingsIcon }[] = [
  { value: "general", label: "General", icon: SettingsIcon },
  { value: "scheduling", label: "Scheduling", icon: Clock },
  { value: "servers", label: "Media Servers", icon: Server },
  { value: "integrations", label: "Integrations", icon: Puzzle },
  { value: "notifications", label: "Notifications", icon: Bell },
  { value: "authentication", label: "Authentication", icon: Lock },
  { value: "system", label: "System", icon: Monitor },
];

const VALID_SETTINGS_TABS = new Set<string>(SETTINGS_TABS.map((t) => t.value));

function getInitialSettingsTab(): SettingsTab {
  if (typeof window === "undefined") return "general";
  const hash = window.location.hash.slice(1);
  return VALID_SETTINGS_TABS.has(hash) ? (hash as SettingsTab) : "general";
}

// ─── Tab navigation helpers ───

function buildSettingsTabs(updateAvailable?: boolean, latestVersion?: string | null): TabNavItem<SettingsTab>[] {
  return SETTINGS_TABS.map((tab) => ({
    value: tab.value,
    label: tab.label,
    icon: tab.icon,
    indicator:
      tab.value === "system" && updateAvailable ? (
        <span
          className="h-2 w-2 rounded-full bg-emerald-400 shrink-0"
          title={latestVersion ? `Update available: v${latestVersion}` : "Update available"}
        />
      ) : undefined,
  }));
}

// ─── Main component ───

export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState<SettingsTab>(getInitialSettingsTab);
  const [servers, setServers] = useState<MediaServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncingServer, setSyncingServer] = useState<string | null>(null);
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
      const linkRes = await fetch("/api/auth/plex/link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ authToken }),
      });
      const linkData = await linkRes.json();
      if (linkData.linked) {
        const infoRes = await fetch("/api/settings/auth");
        setAuthInfo(await infoRes.json());
      } else if (linkData.error) {
        throw new Error(linkData.error);
      }
    },
  });
  // Plex OAuth for servers tab (link account, then redirect to onboarding)
  const plexOAuthForOnboarding = usePlexOAuth({
    onSuccess: async (authToken) => {
      const linkRes = await fetch("/api/auth/plex/link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ authToken }),
      });
      const linkData = await linkRes.json();
      if (linkData.linked) {
        window.location.href = "/onboarding";
      } else if (linkData.error) {
        throw new Error(linkData.error);
      }
    },
  });
  const plexLinking = plexOAuth.isLoading || plexOAuthForOnboarding.isLoading;
  const [credentialsForm, setCredentialsForm] = useState<CredentialsForm>({
    currentPassword: "",
    newUsername: "",
    newPassword: "",
    confirmPassword: "",
  });
  const [credentialsSaving, setCredentialsSaving] = useState(false);
  const [credentialsError, setCredentialsError] = useState("");
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

  // Scheduled job time
  const [scheduledJobTime, setScheduledJobTime] = useState("00:00");
  const [savingJobTime, setSavingJobTime] = useState(false);

  // Sync schedule
  const [syncSchedule, setSyncSchedule] = useState("DAILY");
  const [lastScheduledSync, setLastScheduledSync] = useState<string | null>(null);
  const [savingSchedule, setSavingSchedule] = useState(false);
  const [isCustomSchedule, setIsCustomSchedule] = useState(false);
  const [customCron, setCustomCron] = useState("");
  const [cronError, setCronError] = useState("");

  // Sonarr instances
  const [sonarrInstances, setSonarrInstances] = useState<ArrInstance[]>([]);
  const [showSonarrForm, setShowSonarrForm] = useState(false);
  const [sonarrForm, setSonarrForm] = useState({ name: "", url: "", apiKey: "", externalUrl: "" });
  const [sonarrSaving, setSonarrSaving] = useState(false);
  const [sonarrError, setSonarrError] = useState("");

  // Radarr instances
  const [radarrInstances, setRadarrInstances] = useState<ArrInstance[]>([]);
  const [showRadarrForm, setShowRadarrForm] = useState(false);
  const [radarrForm, setRadarrForm] = useState({ name: "", url: "", apiKey: "", externalUrl: "" });
  const [radarrSaving, setRadarrSaving] = useState(false);
  const [radarrError, setRadarrError] = useState("");

  // Lidarr instances
  const [lidarrInstances, setLidarrInstances] = useState<ArrInstance[]>([]);
  const [showLidarrForm, setShowLidarrForm] = useState(false);
  const [lidarrForm, setLidarrForm] = useState({ name: "", url: "", apiKey: "", externalUrl: "" });
  const [lidarrSaving, setLidarrSaving] = useState(false);
  const [lidarrError, setLidarrError] = useState("");

  // Seerr instances
  const [seerrInstances, setSeerrInstances] = useState<SeerrInstance[]>([]);
  const [showSeerrForm, setShowSeerrForm] = useState(false);
  const [seerrForm, setSeerrForm] = useState({ name: "", url: "", apiKey: "" });
  const [seerrSaving, setSeerrSaving] = useState(false);
  const [seerrError, setSeerrError] = useState("");

  // System info
  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null);

  // Image cache
  const [imageCacheStats, setImageCacheStats] = useState<ImageCacheStats | null>(null);
  const [clearingImageCache, setClearingImageCache] = useState(false);

  // Changelog
  const [releaseNotes, setReleaseNotes] = useState<ReleaseNote[]>([]);
  const [loadingChangelog, setLoadingChangelog] = useState(false);

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

  // Lifecycle detection schedule
  const [lcDetectSchedule, setLcDetectSchedule] = useState("EVERY_6H");
  const [lastLcDetect, setLastLcDetect] = useState<string | null>(null);
  const [savingLcDetect, setSavingLcDetect] = useState(false);
  const [isCustomLcDetect, setIsCustomLcDetect] = useState(false);
  const [customLcDetectCron, setCustomLcDetectCron] = useState("");
  const [lcDetectCronError, setLcDetectCronError] = useState("");

  // Lifecycle execution schedule
  const [lcExecSchedule, setLcExecSchedule] = useState("EVERY_6H");
  const [lastLcExec, setLastLcExec] = useState<string | null>(null);
  const [savingLcExec, setSavingLcExec] = useState(false);
  const [isCustomLcExec, setIsCustomLcExec] = useState(false);
  const [customLcExecCron, setCustomLcExecCron] = useState("");
  const [lcExecCronError, setLcExecCronError] = useState("");
  const [runningJob, setRunningJob] = useState<"sync" | "detection" | "execution" | null>(null);

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

  // Connection test state (add form)
  const [sonarrTesting, setSonarrTesting] = useState(false);
  const [sonarrTestResult, setSonarrTestResult] = useState<TestResult | null>(null);
  const [radarrTesting, setRadarrTesting] = useState(false);
  const [radarrTestResult, setRadarrTestResult] = useState<TestResult | null>(null);
  const [lidarrTesting, setLidarrTesting] = useState(false);
  const [lidarrTestResult, setLidarrTestResult] = useState<TestResult | null>(null);
  const [seerrTesting, setSeerrTesting] = useState(false);
  const [seerrTestResult, setSeerrTestResult] = useState<TestResult | null>(null);

  // Schedule info (next run times)
  const [scheduleInfo, setScheduleInfo] = useState<ScheduleInfo | null>(null);

  // Discord notification settings
  const [discordWebhookUrl, setDiscordWebhookUrl] = useState("");
  const [discordWebhookUsername, setDiscordWebhookUsername] = useState("");
  const [discordWebhookAvatarUrl, setDiscordWebhookAvatarUrl] = useState("");
  const [discordSaving, setDiscordSaving] = useState(false);
  const [discordTesting, setDiscordTesting] = useState(false);
  const [discordTestResult, setDiscordTestResult] = useState<TestResult | null>(null);

  // Sonarr edit state
  const [editingSonarrId, setEditingSonarrId] = useState<string | null>(null);
  const [editSonarrForm, setEditSonarrForm] = useState({ name: "", url: "", apiKey: "", externalUrl: "" });
  const [editSonarrSaving, setEditSonarrSaving] = useState(false);
  const [editSonarrError, setEditSonarrError] = useState("");
  const [editSonarrTesting, setEditSonarrTesting] = useState(false);
  const [editSonarrTestResult, setEditSonarrTestResult] = useState<TestResult | null>(null);

  // Radarr edit state
  const [editingRadarrId, setEditingRadarrId] = useState<string | null>(null);
  const [editRadarrForm, setEditRadarrForm] = useState({ name: "", url: "", apiKey: "", externalUrl: "" });
  const [editRadarrSaving, setEditRadarrSaving] = useState(false);
  const [editRadarrError, setEditRadarrError] = useState("");
  const [editRadarrTesting, setEditRadarrTesting] = useState(false);
  const [editRadarrTestResult, setEditRadarrTestResult] = useState<TestResult | null>(null);

  // Lidarr edit state
  const [editingLidarrId, setEditingLidarrId] = useState<string | null>(null);
  const [editLidarrForm, setEditLidarrForm] = useState({ name: "", url: "", apiKey: "", externalUrl: "" });
  const [editLidarrSaving, setEditLidarrSaving] = useState(false);
  const [editLidarrError, setEditLidarrError] = useState("");
  const [editLidarrTesting, setEditLidarrTesting] = useState(false);
  const [editLidarrTestResult, setEditLidarrTestResult] = useState<TestResult | null>(null);

  // Seerr edit state
  const [editingSeerrId, setEditingSeerrId] = useState<string | null>(null);
  const [editSeerrForm, setEditSeerrForm] = useState({ name: "", url: "", apiKey: "" });
  const [editSeerrSaving, setEditSeerrSaving] = useState(false);
  const [editSeerrError, setEditSeerrError] = useState("");
  const [editSeerrTesting, setEditSeerrTesting] = useState(false);
  const [editSeerrTestResult, setEditSeerrTestResult] = useState<TestResult | null>(null);

  // Sync active tab to URL hash (replaceState avoids creating extra history
  // entries that break browser back/forward navigation in the App Router)
  useEffect(() => {
    const newHash = `#${activeTab}`;
    if (window.location.hash !== newHash) {
      window.history.replaceState(window.history.state, "", newHash);
    }
  }, [activeTab]);

  // ─── Fetchers ───

  const fetchServers = useCallback(async () => {
    try {
      const response = await fetch("/api/servers");
      const data = await response.json();
      setServers(data.servers || []);
    } catch (error) {
      console.error("Failed to fetch servers:", error);
    }
  }, []);

  const fetchSettings = useCallback(async () => {
    try {
      const response = await fetch("/api/settings/sync-schedule");
      const data = await response.json();
      if (data.settings) {
        const schedule = data.settings.syncSchedule;
        if (PRESET_VALUES.includes(schedule)) {
          setSyncSchedule(schedule);
          setIsCustomSchedule(false);
        } else {
          setSyncSchedule("CUSTOM");
          setIsCustomSchedule(true);
          setCustomCron(schedule);
        }
        setLastScheduledSync(data.settings.lastScheduledSync);
      }
    } catch (error) {
      console.error("Failed to fetch settings:", error);
    }
  }, []);

  const fetchDedupSetting = useCallback(async () => {
    try {
      const response = await fetch("/api/settings/dedup");
      if (response.ok) {
        const data = await response.json();
        setDedupStats(data.dedupStats ?? true);
      }
    } catch {
      // Silent
    }
  }, []);

  const fetchSonarrInstances = useCallback(async () => {
    try {
      const response = await fetch("/api/integrations/sonarr");
      const data = await response.json();
      setSonarrInstances(data.instances || []);
    } catch (error) {
      console.error("Failed to fetch Sonarr instances:", error);
    }
  }, []);

  const fetchRadarrInstances = useCallback(async () => {
    try {
      const response = await fetch("/api/integrations/radarr");
      const data = await response.json();
      setRadarrInstances(data.instances || []);
    } catch (error) {
      console.error("Failed to fetch Radarr instances:", error);
    }
  }, []);

  const fetchLidarrInstances = useCallback(async () => {
    try {
      const response = await fetch("/api/integrations/lidarr");
      const data = await response.json();
      setLidarrInstances(data.instances || []);
    } catch (error) {
      console.error("Failed to fetch Lidarr instances:", error);
    }
  }, []);

  const fetchSeerrInstances = useCallback(async () => {
    try {
      const response = await fetch("/api/integrations/seerr");
      const data = await response.json();
      setSeerrInstances(data.instances || []);
    } catch (error) {
      console.error("Failed to fetch Seerr instances:", error);
    }
  }, []);

  const fetchSystemInfo = useCallback(async () => {
    try {
      const response = await fetch("/api/system/info");
      const data = await response.json();
      setSystemInfo(data);
    } catch (error) {
      console.error("Failed to fetch system info:", error);
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
      const response = await fetch("/api/settings/accent-color");
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
      const response = await fetch("/api/settings/chip-colors");
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
      const response = await fetch("/api/settings/log-retention");
      const data = await response.json();
      setLogRetentionDays(data.logRetentionDays ?? 7);
      setLogRetentionInput(String(data.logRetentionDays ?? 7));
    } catch (error) {
      console.error("Failed to fetch log retention:", error);
    }
  }, []);

  const fetchActionRetention = useCallback(async () => {
    try {
      const response = await fetch("/api/settings/action-retention");
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
        fetch("/api/settings/backup-schedule"),
        fetch("/api/backup"),
        fetch("/api/settings/backup-encryption-password"),
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
      const response = await fetch("/api/settings/lifecycle-schedule");
      const data = await response.json();
      if (data.settings) {
        const detect = data.settings.lifecycleDetectionSchedule;
        if (PRESET_VALUES.includes(detect)) {
          setLcDetectSchedule(detect);
          setIsCustomLcDetect(false);
        } else {
          setLcDetectSchedule("CUSTOM");
          setIsCustomLcDetect(true);
          setCustomLcDetectCron(detect);
        }
        setLastLcDetect(data.settings.lastScheduledLifecycleDetection);

        const exec = data.settings.lifecycleExecutionSchedule;
        if (PRESET_VALUES.includes(exec)) {
          setLcExecSchedule(exec);
          setIsCustomLcExec(false);
        } else {
          setLcExecSchedule("CUSTOM");
          setIsCustomLcExec(true);
          setCustomLcExecCron(exec);
        }
        setLastLcExec(data.settings.lastScheduledLifecycleExecution);
      }
    } catch (error) {
      console.error("Failed to fetch lifecycle schedule:", error);
    }
  }, []);

  const fetchScheduleInfo = useCallback(async () => {
    try {
      const response = await fetch("/api/settings/schedule-info");
      const data = await response.json();
      setScheduleInfo(data);
      if (data.scheduledJobTime) {
        setScheduledJobTime(data.scheduledJobTime);
      }
    } catch (error) {
      console.error("Failed to fetch schedule info:", error);
    }
  }, []);

  const fetchDiscordSettings = useCallback(async () => {
    try {
      const response = await fetch("/api/settings/discord");
      const data = await response.json();
      setDiscordWebhookUrl(data.webhookUrl ?? "");
      setDiscordWebhookUsername(data.webhookUsername ?? "");
      setDiscordWebhookAvatarUrl(data.webhookAvatarUrl ?? "");
    } catch (error) {
      console.error("Failed to fetch Discord settings:", error);
    }
  }, []);

  // ─── Initial data loading ───

  useEffect(() => {
    Promise.all([
      fetchServers(),
      fetchSettings(),
      fetchSonarrInstances(),
      fetchRadarrInstances(),
      fetchLidarrInstances(),
      fetchSeerrInstances(),
      fetchSystemInfo(),
      fetchAccentColor(),
      fetchChipColors(),
      fetchLogRetention(),
      fetchActionRetention(),
      fetchBackupSettings(),
      fetchLifecycleSchedule(),
      fetchScheduleInfo(),
      fetchDiscordSettings(),
      fetchDedupSetting(),
      fetchImageCacheStats(),
      fetchChangelog(),
    ]).finally(() => setLoading(false));
    // Fetch auth info separately (non-blocking)
    fetch("/api/settings/auth").then((r) => r.json()).then(setAuthInfo).catch(() => {});
    // Fetch display preferences separately (non-blocking)
    fetch("/api/settings/title-preference").then((r) => r.ok ? r.json() : null).then((data) => { if (data) { setPreferredTitleServerId(data.preferredTitleServerId ?? null); setPreferredArtworkServerId(data.preferredArtworkServerId ?? null); } }).catch(() => {});
  }, [fetchServers, fetchSettings, fetchSonarrInstances, fetchRadarrInstances, fetchLidarrInstances, fetchSeerrInstances, fetchSystemInfo, fetchAccentColor, fetchChipColors, fetchLogRetention, fetchActionRetention, fetchBackupSettings, fetchLifecycleSchedule, fetchScheduleInfo, fetchDiscordSettings, fetchDedupSetting, fetchImageCacheStats, fetchChangelog]);

  // Poll server data during active sync for real-time progress bar
  const hasActiveSync = servers.some(
    (s) => s.syncJobs[0]?.status === "RUNNING" || s.syncJobs[0]?.status === "PENDING"
  );
  useEffect(() => {
    if (!hasActiveSync) return;
    const interval = setInterval(fetchServers, 2000);
    return () => clearInterval(interval);
  }, [hasActiveSync, fetchServers]);

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
    } catch {
      setAddServerError("Failed to save library selections");
    } finally {
      setAddServerSaving(false);
    }
  };

  const syncServer = async (serverId: string, libraryKey?: string) => {
    setSyncingServer(serverId);
    try {
      await fetch(`/api/servers/${serverId}/sync`, {
        method: "POST",
        headers: libraryKey ? { "Content-Type": "application/json" } : undefined,
        body: libraryKey ? JSON.stringify({ libraryKey }) : undefined,
      });
      const interval = setInterval(async () => {
        await fetchServers();
        const server = servers.find((s) => s.id === serverId);
        const latestJob = server?.syncJobs[0];
        if (
          latestJob?.status === "COMPLETED" ||
          latestJob?.status === "FAILED"
        ) {
          clearInterval(interval);
          setSyncingServer(null);
        }
      }, 3000);

      setTimeout(() => {
        clearInterval(interval);
        setSyncingServer(null);
      }, 300000);
    } catch (error) {
      console.error("Failed to trigger sync:", error);
      setSyncingServer(null);
    }
  };

  const syncAllServers = async () => {
    const enabledServers = servers.filter((s) => s.enabled);
    if (enabledServers.length === 0) return;
    try {
      await Promise.allSettled(
        enabledServers.map((server) =>
          fetch(`/api/servers/${server.id}/sync`, { method: "POST" })
        )
      );
      await fetchServers();
    } catch (error) {
      console.error("Failed to trigger sync all:", error);
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
      await fetch(`/api/servers/${removeServerDialog.serverId}${qs}`, { method: "DELETE" });
      setRemoveServerDialog(null);
      await fetchServers();
    } catch (error) {
      console.error("Failed to remove server:", error);
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
      const response = await fetch(`/api/servers/${serverId}`, {
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
      if (res.ok) await fetchServers();
    } catch (error) {
      console.error("Failed to enable server:", error);
    }
  };

  const toggleArrEnabled = async (type: string, id: string, enabled: boolean) => {
    try {
      const res = await fetch(`/api/integrations/${type}/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      if (res.ok) {
        if (type === "sonarr") await fetchSonarrInstances();
        else if (type === "radarr") await fetchRadarrInstances();
        else if (type === "lidarr") await fetchLidarrInstances();
      }
    } catch (error) {
      console.error("Failed to toggle integration enabled:", error);
    }
  };

  const toggleSeerrEnabled = async (id: string, enabled: boolean) => {
    try {
      const res = await fetch(`/api/integrations/seerr/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      if (res.ok) await fetchSeerrInstances();
    } catch (error) {
      console.error("Failed to toggle Seerr enabled:", error);
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
      } else {
        const res = await fetch(`/api/servers/${purgeDialog.serverId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: false, deleteData }),
        });
        if (res.ok) await fetchServers();
      }
    } catch (error) {
      console.error("Failed to disable:", error);
    } finally {
      setPurging(false);
      setPurgeDialog(null);
    }
  };

  // ─── Schedule handlers ───

  const saveSyncSchedule = async (value: string) => {
    setCronError("");
    setSavingSchedule(true);
    try {
      const response = await fetch("/api/settings/sync-schedule", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ syncSchedule: value }),
      });
      if (!response.ok) {
        const data = await response.json();
        setCronError(data.error || "Failed to save schedule");
        return;
      }
      await fetchScheduleInfo();
    } catch (error) {
      console.error("Failed to save schedule:", error);
      setCronError("Failed to save schedule");
    } finally {
      setSavingSchedule(false);
    }
  };

  const saveLcDetectSchedule = async (value: string) => {
    setLcDetectCronError("");
    setSavingLcDetect(true);
    try {
      const response = await fetch("/api/settings/lifecycle-schedule", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lifecycleDetectionSchedule: value }),
      });
      if (!response.ok) {
        const data = await response.json();
        setLcDetectCronError(data.error || "Failed to save schedule");
      }
      await fetchScheduleInfo();
    } catch {
      setLcDetectCronError("Failed to save schedule");
    } finally {
      setSavingLcDetect(false);
    }
  };

  const saveLcExecSchedule = async (value: string) => {
    setLcExecCronError("");
    setSavingLcExec(true);
    try {
      const response = await fetch("/api/settings/lifecycle-schedule", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lifecycleExecutionSchedule: value }),
      });
      if (!response.ok) {
        const data = await response.json();
        setLcExecCronError(data.error || "Failed to save schedule");
      }
      await fetchScheduleInfo();
    } catch {
      setLcExecCronError("Failed to save schedule");
    } finally {
      setSavingLcExec(false);
    }
  };

  const handleScheduleChange = (value: string) => {
    if (value === "CUSTOM") {
      setSyncSchedule("CUSTOM");
      setIsCustomSchedule(true);
      setCronError("");
    } else {
      setSyncSchedule(value);
      setIsCustomSchedule(false);
      setCustomCron("");
      setCronError("");
      saveSyncSchedule(value);
    }
  };

  const handleLcDetectScheduleChange = (value: string) => {
    if (value === "CUSTOM") {
      setLcDetectSchedule("CUSTOM");
      setIsCustomLcDetect(true);
      setLcDetectCronError("");
    } else {
      setLcDetectSchedule(value);
      setIsCustomLcDetect(false);
      setCustomLcDetectCron("");
      setLcDetectCronError("");
      saveLcDetectSchedule(value);
    }
  };

  const handleLcExecScheduleChange = (value: string) => {
    if (value === "CUSTOM") {
      setLcExecSchedule("CUSTOM");
      setIsCustomLcExec(true);
      setLcExecCronError("");
    } else {
      setLcExecSchedule(value);
      setIsCustomLcExec(false);
      setCustomLcExecCron("");
      setLcExecCronError("");
      saveLcExecSchedule(value);
    }
  };

  const handleScheduledJobTimeChange = async (value: string) => {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
      setScheduledJobTime(value);
      return;
    }
    setScheduledJobTime(value);
    setSavingJobTime(true);
    try {
      await fetch("/api/settings/scheduled-job-time", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scheduledJobTime: value }),
      });
      fetchScheduleInfo();
    } catch (error) {
      console.error("Failed to save scheduled job time:", error);
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
        const data = await res.json();
        console.error("Run now failed:", data.error);
      }
      // Refresh schedule info + sync status after completion
      fetchScheduleInfo();
      if (job === "sync") fetchServers();
    } catch (error) {
      console.error("Run now failed:", error);
    } finally {
      setRunningJob(null);
    }
  };

  // ─── General tab handlers ───

  const saveAccentColor = async (name: string) => {
    setAccentColor(name);
    window.dispatchEvent(new CustomEvent("accent-color-changed", { detail: name }));
    try {
      await fetch("/api/settings/accent-color", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accentColor: name }),
      });
    } catch (error) {
      console.error("Failed to save accent color:", error);
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
      await fetch("/api/settings/chip-colors", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chipColors: updated }),
      });
    } catch (error) {
      console.error("Failed to save chip colors:", error);
    }
  };

  const resetChipColors = async () => {
    setChipColors(DEFAULT_CHIP_COLORS);
    updateChipColorContext(DEFAULT_CHIP_COLORS);
    try {
      await fetch("/api/settings/chip-colors", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chipColors: DEFAULT_CHIP_COLORS }),
      });
    } catch (error) {
      console.error("Failed to reset chip colors:", error);
    }
  };

  const saveDedupSetting = async (value: boolean) => {
    setSavingDedup(true);
    try {
      await fetch("/api/settings/dedup", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dedupStats: value }),
      });
      setDedupStats(value);
    } catch (error) {
      console.error("Failed to save dedup setting:", error);
    } finally {
      setSavingDedup(false);
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
      }
    } catch (error) {
      console.error("Failed to save log retention:", error);
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
      }
    } catch (error) {
      console.error("Failed to save action retention:", error);
    } finally {
      setSavingActionRetention(false);
    }
  };

  const savePreferredTitleServer = async (value: string) => {
    const newServerId = value === "none" ? null : value;
    setPreferredTitleServerId(newServerId);
    try {
      await fetch("/api/settings/title-preference", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serverId: newServerId, field: "title" }),
      });
    } catch (error) {
      console.error("Failed to save title preference:", error);
    }
  };

  const savePreferredArtworkServer = async (value: string) => {
    const newServerId = value === "none" ? null : value;
    setPreferredArtworkServerId(newServerId);
    try {
      await fetch("/api/settings/title-preference", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serverId: newServerId, field: "artwork" }),
      });
    } catch (error) {
      console.error("Failed to save artwork preference:", error);
    }
  };

  const handleBackupScheduleChange = async (value: string) => {
    setBackupSchedule(value);
    setBackupSaving(true);
    try {
      await fetch("/api/settings/backup-schedule", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ backupSchedule: value }),
      });
    } catch {} finally {
      setBackupSaving(false);
    }
  };

  const handleSaveBackupRetention = async () => {
    setBackupSaving(true);
    try {
      await fetch("/api/settings/backup-schedule", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ backupRetentionCount }),
      });
    } catch {} finally {
      setBackupSaving(false);
    }
  };

  const handleCreateBackup = async (includeMediaData = false) => {
    setCreatingBackup(true);
    try {
      const res = await fetch("/api/backup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ includeMediaData }),
      });
      if (res.ok) await fetchBackupSettings();
    } catch {} finally {
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
      }
    } catch {} finally {
      setSavingBackupPassword(false);
    }
  };

  const handleDownloadBackup = (filename: string) => {
    window.open(`/api/backup/${encodeURIComponent(filename)}`, "_blank");
  };

  const handleRestoreBackup = async (filename: string, passphrase?: string) => {
    if (!confirm(`Restore from "${filename}"?\n\nThis will replace ALL current data and log you out. This cannot be undone.`)) return;
    setRestoringBackup(filename);
    setRestoreProgress(null);
    try {
      const res = await fetch("/api/backup/restore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename, ...(passphrase ? { passphrase } : {}) }),
      });
      if (!res.body) {
        alert("Restore failed");
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
        alert(lastError || "Restore failed");
      }
    } catch {} finally {
      setRestoringBackup(null);
      setRestoreProgress(null);
    }
  };

  const handleDeleteBackup = async (filename: string) => {
    if (!confirm(`Delete backup "${filename}"?`)) return;
    await fetch(`/api/backup/${encodeURIComponent(filename)}`, { method: "DELETE" });
    await fetchBackupSettings();
  };

  // ─── Integration handlers ───

  const addSonarrInstance = async () => {
    setSonarrSaving(true);
    setSonarrError("");
    try {
      const response = await fetch("/api/integrations/sonarr", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sonarrForm),
      });
      const data = await response.json();
      if (!response.ok) {
        setSonarrError(data.error || "Failed to add Sonarr instance");
        return;
      }
      setSonarrForm({ name: "", url: "", apiKey: "", externalUrl: "" });
      setShowSonarrForm(false);
      await fetchSonarrInstances();
    } catch (error) {
      setSonarrError("Failed to add Sonarr instance");
      console.error(error);
    } finally {
      setSonarrSaving(false);
    }
  };

  const deleteSonarrInstance = async (id: string) => {
    try {
      await fetch(`/api/integrations/sonarr/${id}`, { method: "DELETE" });
      await fetchSonarrInstances();
    } catch (error) {
      console.error("Failed to delete Sonarr instance:", error);
    }
  };

  const addRadarrInstance = async () => {
    setRadarrSaving(true);
    setRadarrError("");
    try {
      const response = await fetch("/api/integrations/radarr", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(radarrForm),
      });
      const data = await response.json();
      if (!response.ok) {
        setRadarrError(data.error || "Failed to add Radarr instance");
        return;
      }
      setRadarrForm({ name: "", url: "", apiKey: "", externalUrl: "" });
      setShowRadarrForm(false);
      await fetchRadarrInstances();
    } catch (error) {
      setRadarrError("Failed to add Radarr instance");
      console.error(error);
    } finally {
      setRadarrSaving(false);
    }
  };

  const deleteRadarrInstance = async (id: string) => {
    try {
      await fetch(`/api/integrations/radarr/${id}`, { method: "DELETE" });
      await fetchRadarrInstances();
    } catch (error) {
      console.error("Failed to delete Radarr instance:", error);
    }
  };

  const addLidarrInstance = async () => {
    setLidarrSaving(true);
    setLidarrError("");
    try {
      const response = await fetch("/api/integrations/lidarr", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(lidarrForm),
      });
      const data = await response.json();
      if (!response.ok) {
        setLidarrError(data.error || "Failed to add Lidarr instance");
        return;
      }
      setLidarrForm({ name: "", url: "", apiKey: "", externalUrl: "" });
      setShowLidarrForm(false);
      await fetchLidarrInstances();
    } catch (error) {
      setLidarrError("Failed to add Lidarr instance");
      console.error(error);
    } finally {
      setLidarrSaving(false);
    }
  };

  const deleteLidarrInstance = async (id: string) => {
    try {
      await fetch(`/api/integrations/lidarr/${id}`, { method: "DELETE" });
      await fetchLidarrInstances();
    } catch (error) {
      console.error("Failed to delete Lidarr instance:", error);
    }
  };

  const addSeerrInstance = async () => {
    setSeerrSaving(true);
    setSeerrError("");
    try {
      const response = await fetch("/api/integrations/seerr", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(seerrForm),
      });
      const data = await response.json();
      if (!response.ok) {
        setSeerrError(data.error || "Failed to add Seerr instance");
        return;
      }
      setSeerrForm({ name: "", url: "", apiKey: "" });
      setShowSeerrForm(false);
      await fetchSeerrInstances();
    } catch (error) {
      setSeerrError("Failed to add Seerr instance");
      console.error(error);
    } finally {
      setSeerrSaving(false);
    }
  };

  const deleteSeerrInstance = async (id: string) => {
    try {
      await fetch(`/api/integrations/seerr/${id}`, { method: "DELETE" });
      await fetchSeerrInstances();
    } catch (error) {
      console.error("Failed to delete Seerr instance:", error);
    }
  };

  const testArrConnection = async (type: "sonarr" | "radarr" | "lidarr" | "seerr", url: string, apiKey: string, setTesting: (v: boolean) => void, setResult: (v: TestResult | null) => void) => {
    setTesting(true);
    setResult(null);
    try {
      const response = await fetch(`/api/integrations/${type}/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, apiKey }),
      });
      const data = await response.json();
      setResult(data);
    } catch {
      setResult({ ok: false, error: "Request failed" });
    } finally {
      setTesting(false);
    }
  };

  // Test connection for existing instances (uses server-side stored credentials)
  const testEditArrConnection = async (type: "sonarr" | "radarr" | "lidarr" | "seerr", id: string, overrides: { url?: string; apiKey?: string }, setTesting: (v: boolean) => void, setResult: (v: TestResult | null) => void) => {
    setTesting(true);
    setResult(null);
    try {
      const body: Record<string, string> = {};
      if (overrides.url) body.url = overrides.url;
      if (overrides.apiKey) body.apiKey = overrides.apiKey;
      const response = await fetch(`/api/integrations/${type}/${id}/test-connection`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      setResult(data);
    } catch {
      setResult({ ok: false, error: "Request failed" });
    } finally {
      setTesting(false);
    }
  };

  // Sonarr edit handlers
  const startEditSonarr = (instance: ArrInstance) => {
    setEditingSonarrId(instance.id);
    setEditSonarrForm({ name: instance.name, url: instance.url, apiKey: "", externalUrl: instance.externalUrl ?? "" });
    setEditSonarrError("");
    setEditSonarrTestResult(null);
    testEditArrConnection("sonarr", instance.id, {}, setEditSonarrTesting, setEditSonarrTestResult);
  };

  const saveEditSonarr = async () => {
    setEditSonarrSaving(true);
    setEditSonarrError("");
    try {
      const body: Record<string, string> = {};
      if (editSonarrForm.name) body.name = editSonarrForm.name;
      if (editSonarrForm.url) body.url = editSonarrForm.url;
      if (editSonarrForm.apiKey) body.apiKey = editSonarrForm.apiKey;
      body.externalUrl = editSonarrForm.externalUrl;

      const response = await fetch(`/api/integrations/sonarr/${editingSonarrId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok) {
        setEditSonarrError(data.detail ? `${data.error} — ${data.detail}` : (data.error || "Failed to update"));
        return;
      }
      setEditingSonarrId(null);
      await fetchSonarrInstances();
    } catch {
      setEditSonarrError("Failed to update Sonarr instance");
    } finally {
      setEditSonarrSaving(false);
    }
  };

  // Radarr edit handlers
  const startEditRadarr = (instance: ArrInstance) => {
    setEditingRadarrId(instance.id);
    setEditRadarrForm({ name: instance.name, url: instance.url, apiKey: "", externalUrl: instance.externalUrl ?? "" });
    setEditRadarrError("");
    setEditRadarrTestResult(null);
    testEditArrConnection("radarr", instance.id, {}, setEditRadarrTesting, setEditRadarrTestResult);
  };

  const saveEditRadarr = async () => {
    setEditRadarrSaving(true);
    setEditRadarrError("");
    try {
      const body: Record<string, string> = {};
      if (editRadarrForm.name) body.name = editRadarrForm.name;
      if (editRadarrForm.url) body.url = editRadarrForm.url;
      if (editRadarrForm.apiKey) body.apiKey = editRadarrForm.apiKey;
      body.externalUrl = editRadarrForm.externalUrl;

      const response = await fetch(`/api/integrations/radarr/${editingRadarrId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok) {
        setEditRadarrError(data.detail ? `${data.error} — ${data.detail}` : (data.error || "Failed to update"));
        return;
      }
      setEditingRadarrId(null);
      await fetchRadarrInstances();
    } catch {
      setEditRadarrError("Failed to update Radarr instance");
    } finally {
      setEditRadarrSaving(false);
    }
  };

  // Lidarr edit handlers
  const startEditLidarr = (instance: ArrInstance) => {
    setEditingLidarrId(instance.id);
    setEditLidarrForm({ name: instance.name, url: instance.url, apiKey: "", externalUrl: instance.externalUrl ?? "" });
    setEditLidarrError("");
    setEditLidarrTestResult(null);
    testEditArrConnection("lidarr", instance.id, {}, setEditLidarrTesting, setEditLidarrTestResult);
  };

  const saveEditLidarr = async () => {
    setEditLidarrSaving(true);
    setEditLidarrError("");
    try {
      const body: Record<string, string> = {};
      if (editLidarrForm.name) body.name = editLidarrForm.name;
      if (editLidarrForm.url) body.url = editLidarrForm.url;
      if (editLidarrForm.apiKey) body.apiKey = editLidarrForm.apiKey;
      body.externalUrl = editLidarrForm.externalUrl;

      const response = await fetch(`/api/integrations/lidarr/${editingLidarrId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok) {
        setEditLidarrError(data.detail ? `${data.error} — ${data.detail}` : (data.error || "Failed to update"));
        return;
      }
      setEditingLidarrId(null);
      await fetchLidarrInstances();
    } catch {
      setEditLidarrError("Failed to update Lidarr instance");
    } finally {
      setEditLidarrSaving(false);
    }
  };

  // Seerr edit handlers
  const startEditSeerr = (instance: SeerrInstance) => {
    setEditingSeerrId(instance.id);
    setEditSeerrForm({ name: instance.name, url: instance.url, apiKey: "" });
    setEditSeerrError("");
    setEditSeerrTestResult(null);
    testEditArrConnection("seerr", instance.id, {}, setEditSeerrTesting, setEditSeerrTestResult);
  };

  const saveEditSeerr = async () => {
    setEditSeerrSaving(true);
    setEditSeerrError("");
    try {
      const body: Record<string, string> = {};
      if (editSeerrForm.name) body.name = editSeerrForm.name;
      if (editSeerrForm.url) body.url = editSeerrForm.url;
      if (editSeerrForm.apiKey) body.apiKey = editSeerrForm.apiKey;

      const response = await fetch(`/api/integrations/seerr/${editingSeerrId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok) {
        setEditSeerrError(data.detail ? `${data.error} — ${data.detail}` : (data.error || "Failed to update"));
        return;
      }
      setEditingSeerrId(null);
      await fetchSeerrInstances();
    } catch {
      setEditSeerrError("Failed to update Seerr instance");
    } finally {
      setEditSeerrSaving(false);
    }
  };

  // ─── Notification handlers ───

  const saveDiscordSettings = async () => {
    setDiscordSaving(true);
    setDiscordTestResult(null);
    try {
      await fetch("/api/settings/discord", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          webhookUrl: discordWebhookUrl,
          webhookUsername: discordWebhookUsername,
          webhookAvatarUrl: discordWebhookAvatarUrl,
        }),
      });
    } catch (error) {
      console.error("Failed to save Discord settings:", error);
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
      } else {
        setDiscordTestResult({ ok: false, error: data.error || "Test failed" });
      }
    } catch (error) {
      setDiscordTestResult({ ok: false, error: "Request failed" });
      console.error("Failed to test Discord webhook:", error);
    } finally {
      setDiscordTesting(false);
    }
  };

  // ─── Authentication handlers ───

  const handlePlexLink = () => plexOAuth.startAuth();

  const handleToggleLocalAuth = async (checked: boolean) => {
    // If enabling and no credentials exist, prompt to create them first
    if (checked && !authInfo?.hasPassword) {
      setPromptForm({ username: "", password: "", confirmPassword: "" });
      setPromptError("");
      setShowCredentialPrompt(true);
      return;
    }
    setAuthLoading(true);
    try {
      const res = await fetch("/api/settings/auth", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ localAuthEnabled: checked }),
      });
      if (res.ok) {
        setAuthInfo((prev) => prev ? { ...prev, localAuthEnabled: checked } : prev);
      }
    } catch {} finally {
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

    setCredentialsSaving(true);
    try {
      const body: Record<string, string> = {
        currentPassword: credentialsForm.currentPassword,
      };
      if (credentialsForm.newPassword) body.newPassword = credentialsForm.newPassword;
      if (credentialsForm.newUsername) body.newUsername = credentialsForm.newUsername;

      const res = await fetch("/api/auth/local/change-password", {
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
      setCredentialsForm({ currentPassword: "", newUsername: "", newPassword: "", confirmPassword: "" });
      // Refresh auth info to show updated username
      const infoRes = await fetch("/api/settings/auth");
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
    if (promptForm.password.length < 8) {
      setPromptError("Password must be at least 8 characters");
      return;
    }
    if (promptForm.password !== promptForm.confirmPassword) {
      setPromptError("Passwords do not match");
      return;
    }
    setPromptSaving(true);
    try {
      // Create credentials
      const credRes = await fetch("/api/auth/local/change-password", {
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
      // Enable local auth
      const authRes = await fetch("/api/settings/auth", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ localAuthEnabled: true }),
      });
      if (authRes.ok) {
        // Refresh auth info
        const infoRes = await fetch("/api/settings/auth");
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

  const handleClearImageCache = async () => {
    setClearingImageCache(true);
    try {
      await fetch("/api/settings/image-cache", { method: "DELETE" });
      await fetchImageCacheStats();
    } catch {
      // Ignore
    } finally {
      setClearingImageCache(false);
    }
  };

  // ─── Helpers ───

  const formatDate = (date: string | null) => {
    if (!date) return "Never";
    return new Date(date).toLocaleString();
  };

  const formatNextRun = (nextRun: string | null, lastRun: string | null) => {
    if (!nextRun) return "Manual only";
    const d = new Date(nextRun);
    const diffMs = d.getTime() - Date.now();
    if (diffMs > 0) return d.toLocaleString();
    // Never run before — waiting for first scheduler tick
    if (!lastRun) return "Pending";
    // Past date — scheduler hasn't picked it up yet
    const overdueMs = Math.abs(diffMs);
    if (overdueMs <= 15 * 60 * 1000) return "Due now";
    const mins = Math.round(overdueMs / 60000);
    if (mins < 60) return `Overdue (${mins}m ago)`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `Overdue (${hrs}h ago)`;
    return `Overdue (${Math.round(hrs / 24)}d ago)`;
  };

  // ─── Loading gate ───

  if (loading) {
    return <SettingsSkeleton />;
  }

  // ─── Render ───

  return (
    <div className="p-4 sm:p-6 lg:p-8">
      <div className="mb-6">
        <h1 className="text-2xl sm:text-3xl font-bold font-display tracking-tight">Settings</h1>
      </div>

      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as SettingsTab)} className="space-y-6">
        <TabNav
          tabs={buildSettingsTabs(systemInfo?.updateInfo?.updateAvailable, systemInfo?.updateInfo?.latestVersion)}
          activeTab={activeTab}
          onTabChange={setActiveTab}
          className="mb-6"
        />

        <TabsContent value="general">
          <GeneralTab
            accentColor={accentColor}
            onSaveAccentColor={saveAccentColor}
            chipColors={chipColors}
            onSaveChipColor={saveChipColor}
            onResetChipColors={resetChipColors}
            dedupStats={dedupStats}
            savingDedup={savingDedup}
            onSaveDedupSetting={saveDedupSetting}
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
            backupSchedule={backupSchedule}
            backupRetentionCount={backupRetentionCount}
            backups={backups}
            backupLoading={backupLoading}
            backupSaving={backupSaving}
            creatingBackup={creatingBackup}
            restoringBackup={restoringBackup}
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
        </TabsContent>

        <TabsContent value="scheduling">
          <SchedulingTab
            scheduledJobTime={scheduledJobTime}
            savingJobTime={savingJobTime}
            onScheduledJobTimeChange={handleScheduledJobTimeChange}
            syncSchedule={syncSchedule}
            isCustomSchedule={isCustomSchedule}
            customCron={customCron}
            cronError={cronError}
            savingSchedule={savingSchedule}
            lastScheduledSync={lastScheduledSync}
            onSyncScheduleChange={handleScheduleChange}
            onCustomCronChange={setCustomCron}
            onSaveSyncSchedule={saveSyncSchedule}
            lcDetectSchedule={lcDetectSchedule}
            isCustomLcDetect={isCustomLcDetect}
            customLcDetectCron={customLcDetectCron}
            lcDetectCronError={lcDetectCronError}
            savingLcDetect={savingLcDetect}
            lastLcDetect={lastLcDetect}
            onLcDetectScheduleChange={handleLcDetectScheduleChange}
            onCustomLcDetectCronChange={setCustomLcDetectCron}
            onSaveLcDetectSchedule={saveLcDetectSchedule}
            lcExecSchedule={lcExecSchedule}
            isCustomLcExec={isCustomLcExec}
            customLcExecCron={customLcExecCron}
            lcExecCronError={lcExecCronError}
            savingLcExec={savingLcExec}
            lastLcExec={lastLcExec}
            onLcExecScheduleChange={handleLcExecScheduleChange}
            onCustomLcExecCronChange={setCustomLcExecCron}
            onSaveLcExecSchedule={saveLcExecSchedule}
            timezone={scheduleInfo?.timezone ?? null}
            scheduleInfo={scheduleInfo}
            runningJob={runningJob}
            onRunNow={handleRunNow}
            formatDate={formatDate}
            formatNextRun={formatNextRun}
          />
        </TabsContent>

        <TabsContent value="servers">
          <ServersTab
            servers={servers}
            hasActiveSync={hasActiveSync}
            syncingServer={syncingServer}
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
          />
        </TabsContent>

        <TabsContent value="integrations">
          <IntegrationsTab
            sonarr={{
              instances: sonarrInstances,
              showForm: showSonarrForm,
              form: sonarrForm,
              saving: sonarrSaving,
              error: sonarrError,
              testing: sonarrTesting,
              testResult: sonarrTestResult,
              editing: {
                id: editingSonarrId,
                form: editSonarrForm,
                saving: editSonarrSaving,
                error: editSonarrError,
                testing: editSonarrTesting,
                testResult: editSonarrTestResult,
              },
              onShowForm: setShowSonarrForm,
              onFormChange: (form) => {
                if (form.url !== sonarrForm.url || form.apiKey !== sonarrForm.apiKey) setSonarrTestResult(null);
                setSonarrForm(form);
              },
              onAdd: addSonarrInstance,
              onDelete: deleteSonarrInstance,
              onTest: () => testArrConnection("sonarr", sonarrForm.url, sonarrForm.apiKey, setSonarrTesting, setSonarrTestResult),
              onStartEdit: startEditSonarr,
              onSaveEdit: saveEditSonarr,
              onCancelEdit: () => setEditingSonarrId(null),
              onEditFormChange: (form) => {
                if (form.url !== editSonarrForm.url || form.apiKey !== editSonarrForm.apiKey) setEditSonarrTestResult(null);
                setEditSonarrForm(form);
              },
              onEditTest: () => testEditArrConnection("sonarr", editingSonarrId!, { url: editSonarrForm.url, apiKey: editSonarrForm.apiKey }, setEditSonarrTesting, setEditSonarrTestResult),
              onToggleEnabled: (id: string, enabled: boolean) => toggleArrEnabled("sonarr", id, enabled),
            }}
            radarr={{
              instances: radarrInstances,
              showForm: showRadarrForm,
              form: radarrForm,
              saving: radarrSaving,
              error: radarrError,
              testing: radarrTesting,
              testResult: radarrTestResult,
              editing: {
                id: editingRadarrId,
                form: editRadarrForm,
                saving: editRadarrSaving,
                error: editRadarrError,
                testing: editRadarrTesting,
                testResult: editRadarrTestResult,
              },
              onShowForm: setShowRadarrForm,
              onFormChange: (form) => {
                if (form.url !== radarrForm.url || form.apiKey !== radarrForm.apiKey) setRadarrTestResult(null);
                setRadarrForm(form);
              },
              onAdd: addRadarrInstance,
              onDelete: deleteRadarrInstance,
              onTest: () => testArrConnection("radarr", radarrForm.url, radarrForm.apiKey, setRadarrTesting, setRadarrTestResult),
              onStartEdit: startEditRadarr,
              onSaveEdit: saveEditRadarr,
              onCancelEdit: () => setEditingRadarrId(null),
              onEditFormChange: (form) => {
                if (form.url !== editRadarrForm.url || form.apiKey !== editRadarrForm.apiKey) setEditRadarrTestResult(null);
                setEditRadarrForm(form);
              },
              onEditTest: () => testEditArrConnection("radarr", editingRadarrId!, { url: editRadarrForm.url, apiKey: editRadarrForm.apiKey }, setEditRadarrTesting, setEditRadarrTestResult),
              onToggleEnabled: (id: string, enabled: boolean) => toggleArrEnabled("radarr", id, enabled),
            }}
            lidarr={{
              instances: lidarrInstances,
              showForm: showLidarrForm,
              form: lidarrForm,
              saving: lidarrSaving,
              error: lidarrError,
              testing: lidarrTesting,
              testResult: lidarrTestResult,
              editing: {
                id: editingLidarrId,
                form: editLidarrForm,
                saving: editLidarrSaving,
                error: editLidarrError,
                testing: editLidarrTesting,
                testResult: editLidarrTestResult,
              },
              onShowForm: setShowLidarrForm,
              onFormChange: (form) => {
                if (form.url !== lidarrForm.url || form.apiKey !== lidarrForm.apiKey) setLidarrTestResult(null);
                setLidarrForm(form);
              },
              onAdd: addLidarrInstance,
              onDelete: deleteLidarrInstance,
              onTest: () => testArrConnection("lidarr", lidarrForm.url, lidarrForm.apiKey, setLidarrTesting, setLidarrTestResult),
              onStartEdit: startEditLidarr,
              onSaveEdit: saveEditLidarr,
              onCancelEdit: () => setEditingLidarrId(null),
              onEditFormChange: (form) => {
                if (form.url !== editLidarrForm.url || form.apiKey !== editLidarrForm.apiKey) setEditLidarrTestResult(null);
                setEditLidarrForm(form);
              },
              onEditTest: () => testEditArrConnection("lidarr", editingLidarrId!, { url: editLidarrForm.url, apiKey: editLidarrForm.apiKey }, setEditLidarrTesting, setEditLidarrTestResult),
              onToggleEnabled: (id: string, enabled: boolean) => toggleArrEnabled("lidarr", id, enabled),
            }}
            seerr={{
              instances: seerrInstances,
              showForm: showSeerrForm,
              form: seerrForm,
              saving: seerrSaving,
              error: seerrError,
              testing: seerrTesting,
              testResult: seerrTestResult,
              editing: {
                id: editingSeerrId,
                form: editSeerrForm,
                saving: editSeerrSaving,
                error: editSeerrError,
                testing: editSeerrTesting,
                testResult: editSeerrTestResult,
              },
              onShowForm: setShowSeerrForm,
              onFormChange: (form) => {
                if (form.url !== seerrForm.url || form.apiKey !== seerrForm.apiKey) setSeerrTestResult(null);
                setSeerrForm(form);
              },
              onAdd: addSeerrInstance,
              onDelete: deleteSeerrInstance,
              onTest: () => testArrConnection("seerr", seerrForm.url, seerrForm.apiKey, setSeerrTesting, setSeerrTestResult),
              onStartEdit: startEditSeerr,
              onSaveEdit: saveEditSeerr,
              onCancelEdit: () => setEditingSeerrId(null),
              onEditFormChange: (form) => {
                if (form.url !== editSeerrForm.url || form.apiKey !== editSeerrForm.apiKey) setEditSeerrTestResult(null);
                setEditSeerrForm(form);
              },
              onEditTest: () => testEditArrConnection("seerr", editingSeerrId!, { url: editSeerrForm.url, apiKey: editSeerrForm.apiKey }, setEditSeerrTesting, setEditSeerrTestResult),
              onToggleEnabled: (id: string, enabled: boolean) => toggleSeerrEnabled(id, enabled),
            }}
          />
        </TabsContent>

        <TabsContent value="notifications">
          <NotificationsTab
            discordWebhookUrl={discordWebhookUrl}
            discordWebhookUsername={discordWebhookUsername}
            discordWebhookAvatarUrl={discordWebhookAvatarUrl}
            discordSaving={discordSaving}
            discordTesting={discordTesting}
            discordTestResult={discordTestResult}
            onDiscordWebhookUrlChange={setDiscordWebhookUrl}
            onDiscordWebhookUsernameChange={setDiscordWebhookUsername}
            onDiscordWebhookAvatarUrlChange={setDiscordWebhookAvatarUrl}
            onSaveDiscordSettings={saveDiscordSettings}
            onTestDiscordWebhook={testDiscordWebhook}
          />
        </TabsContent>

        <TabsContent value="authentication">
          <AuthenticationTab
            authInfo={authInfo}
            authLoading={authLoading}
            plexLinking={plexLinking}
            credentialsForm={credentialsForm}
            credentialsSaving={credentialsSaving}
            credentialsError={credentialsError}
            credentialsSuccess={credentialsSuccess}
            showCredentialPrompt={showCredentialPrompt}
            promptForm={promptForm}
            promptError={promptError}
            promptSaving={promptSaving}
            onSetCredentialsForm={setCredentialsForm}
            onSetPromptForm={setPromptForm}
            onSetShowCredentialPrompt={setShowCredentialPrompt}
            onToggleLocalAuth={handleToggleLocalAuth}
            onChangeCredentials={handleChangeCredentials}
            onPlexLink={handlePlexLink}
            onCreateCredentialsAndEnable={handleCreateCredentialsAndEnable}
          />
        </TabsContent>

        <TabsContent value="system">
          <SystemTab
            systemInfo={systemInfo}
            imageCacheStats={imageCacheStats}
            clearingImageCache={clearingImageCache}
            onClearImageCache={handleClearImageCache}
            releaseNotes={releaseNotes}
            loadingChangelog={loadingChangelog}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
