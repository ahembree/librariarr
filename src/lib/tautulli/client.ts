import axios, { AxiosInstance } from "axios";
import { logger } from "@/lib/logger";
import { IntegrationError } from "@/lib/integration-error";
import { configureRetry } from "@/lib/http-retry";

// --- Normalized response shapes ---

/** A single Tautulli get_history row (one logical play when grouping=1). */
export interface TautulliHistoryRow {
  rowId: string; // row_id — stable, the upsert key
  referenceId: string | null; // reference_id — group anchor for paused/continued segments
  ratingKey: string | null;
  grandparentRatingKey: string | null;
  guid: string | null;
  user: string;
  mediaType: string | null;
  watchedAt: Date | null; // from `date`
  startedAt: Date | null;
  stoppedAt: Date | null;
  playDurationSec: number | null;
  pausedCounter: number | null;
  percentComplete: number | null;
  ipAddress: string | null;
  location: string | null;
  platform: string | null;
  player: string | null;
  product: string | null;
  transcodeDecision: string | null;
  videoDecision: string | null;
  audioDecision: string | null;
}

/** Tautulli get_stream_data — source-vs-delivered detail for one play. */
export interface TautulliStreamData {
  // Source (on disk)
  sourceVideoCodec: string | null;
  sourceAudioCodec: string | null;
  sourceContainer: string | null;
  sourceVideoResolution: string | null;
  sourceVideoDynamicRange: string | null;
  // Delivered (what was streamed)
  streamVideoCodec: string | null;
  streamAudioCodec: string | null;
  streamContainer: string | null;
  streamSubtitleCodec: string | null;
  streamVideoResolution: string | null;
  streamVideoBitrate: number | null;
  streamAudioBitrate: number | null;
  streamBitrate: number | null;
  streamVideoDynamicRange: string | null;
  // Decisions
  videoDecision: string | null;
  audioDecision: string | null;
  subtitleDecision: string | null;
  transcodeHwDecode: string | null;
  transcodeHwEncode: string | null;
}

interface TautulliEnvelope<T> {
  response?: { result?: string; message?: string | null; data?: T };
}

/** Epoch-seconds (or numeric string) → Date, or null when absent/zero. */
function epochToDate(value: unknown): Date | null {
  const n = typeof value === "string" ? Number(value) : (value as number);
  if (n == null || !Number.isFinite(n) || n <= 0) return null;
  return new Date(n * 1000);
}

function str(value: unknown): string | null {
  if (value == null) return null;
  const s = String(value).trim();
  return s.length > 0 ? s : null;
}

function num(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export class TautulliClient {
  private client: AxiosInstance;
  private apiKey: string;

  constructor(baseURL: string, apiKey: string) {
    this.apiKey = apiKey;
    this.client = axios.create({
      baseURL: baseURL.replace(/\/+$/, ""),
      headers: { Accept: "application/json" },
      timeout: 15000,
    });

    this.client.interceptors.request.use((config) => {
      (config as unknown as Record<string, unknown>).__startTime = Date.now();
      return config;
    });

    this.client.interceptors.response.use(
      (response) => response,
      (error) => {
        if (axios.isAxiosError(error)) {
          const start = (error.config as unknown as Record<string, unknown>)?.__startTime as number | undefined;
          const duration = start ? ` (${Date.now() - start}ms)` : "";
          logger.debug("Tautulli", `ERROR ${error.response?.status ?? "NETWORK"} ${error.config?.url}${duration}`, {
            message: error.message,
          });
          return Promise.reject(new IntegrationError("Tautulli", error));
        }
        return Promise.reject(error);
      }
    );

    configureRetry(this.client, "Tautulli", logger);
  }

  /**
   * Issue a Tautulli API command. Auth + command go in the query string, and the
   * payload is wrapped in `response` — a 200 with `result: "error"` is the failure
   * mode, so unwrap and check `result` rather than trusting the HTTP status.
   */
  private async command<T>(cmd: string, params: Record<string, unknown> = {}): Promise<T> {
    const { data } = await this.client.get<TautulliEnvelope<T>>("/api/v2", {
      params: { apikey: this.apiKey, cmd, out_type: "json", ...params },
    });
    const result = data?.response?.result;
    if (result !== "success") {
      throw new Error(data?.response?.message || `Tautulli command "${cmd}" failed`);
    }
    return data.response!.data as T;
  }

  async testConnection(): Promise<{ ok: boolean; error?: string; appName?: string; version?: string }> {
    try {
      const info = await this.command<{ pms_name?: string; pms_version?: string }>("get_server_info");
      return { ok: true, appName: info?.pms_name, version: info?.pms_version };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Connection failed";
      return { ok: false, error: msg };
    }
  }

  /**
   * Fetch a page of watch history. With `grouping: 1` Tautulli collapses
   * pause-split segments of one play into a single row (anchored by reference_id).
   */
  async getHistory(opts: {
    after?: string; // "YYYY-MM-DD"
    start?: number;
    length?: number;
    grouping?: 0 | 1;
  } = {}): Promise<{ rows: TautulliHistoryRow[]; recordsFiltered: number }> {
    const data = await this.command<{
      data?: Record<string, unknown>[];
      recordsFiltered?: number;
    }>("get_history", {
      grouping: opts.grouping ?? 1,
      order_column: "date",
      order_dir: "asc",
      start: opts.start ?? 0,
      length: opts.length ?? 1000,
      ...(opts.after ? { after: opts.after } : {}),
    });

    const rows = (data?.data ?? []).map((r): TautulliHistoryRow => ({
      rowId: String(r.row_id ?? ""),
      referenceId: r.reference_id != null ? String(r.reference_id) : null,
      ratingKey: str(r.rating_key),
      grandparentRatingKey: str(r.grandparent_rating_key),
      guid: str(r.guid),
      user: str(r.user) ?? "Unknown",
      mediaType: str(r.media_type),
      watchedAt: epochToDate(r.date),
      startedAt: epochToDate(r.started),
      stoppedAt: epochToDate(r.stopped),
      playDurationSec: num(r.play_duration),
      pausedCounter: num(r.paused_counter),
      percentComplete: num(r.percent_complete),
      ipAddress: str(r.ip_address),
      location: str(r.location),
      platform: str(r.platform),
      player: str(r.player),
      product: str(r.product),
      transcodeDecision: str(r.transcode_decision),
      videoDecision: str(r.video_decision),
      audioDecision: str(r.audio_decision),
    }));

    return { rows, recordsFiltered: num(data?.recordsFiltered) ?? rows.length };
  }

  /** Source→delivered stream detail for a single history row. */
  async getStreamData(rowId: string): Promise<TautulliStreamData> {
    const d = await this.command<Record<string, unknown>>("get_stream_data", { row_id: rowId });
    return {
      sourceVideoCodec: str(d.video_codec),
      sourceAudioCodec: str(d.audio_codec),
      sourceContainer: str(d.container),
      sourceVideoResolution: str(d.video_resolution),
      sourceVideoDynamicRange: str(d.video_dynamic_range),
      streamVideoCodec: str(d.stream_video_codec),
      streamAudioCodec: str(d.stream_audio_codec),
      streamContainer: str(d.stream_container),
      streamSubtitleCodec: str(d.stream_subtitle_codec),
      streamVideoResolution: str(d.stream_video_resolution),
      streamVideoBitrate: num(d.stream_video_bitrate),
      streamAudioBitrate: num(d.stream_audio_bitrate),
      streamBitrate: num(d.stream_bitrate),
      streamVideoDynamicRange: str(d.stream_video_dynamic_range),
      videoDecision: str(d.video_decision),
      audioDecision: str(d.audio_decision),
      subtitleDecision: str(d.subtitle_decision),
      transcodeHwDecode: str(d.transcode_hw_decoding),
      transcodeHwEncode: str(d.transcode_hw_encoding),
    };
  }
}
