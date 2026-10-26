/**
 * Transcode vs direct play, decided one way for a live session (the Stream
 * Manager) and for a recorded play (History, the per-item play lists), so a
 * play labelled "Transcode" while it was live is still "Transcode" in its
 * history. Client-safe.
 */

export type StreamDecisionKind = "transcode" | "direct-stream" | "direct-play";

export interface StreamDecisionInput {
  /** Tracearr's verdict: any re-encode, audio-only included. */
  isTranscode?: boolean | null;
  /** "transcode" | "copy" | "directplay" — as the server or Tracearr reports it. */
  videoDecision?: string | null;
  audioDecision?: string | null;
}

export interface StreamDecision {
  kind: StreamDecisionKind;
  label: "Transcode" | "Direct Stream" | "Direct Play";
}

const LABELS: Record<StreamDecisionKind, StreamDecision["label"]> = {
  transcode: "Transcode",
  "direct-stream": "Direct Stream",
  "direct-play": "Direct Play",
};

/**
 * ANY re-encode — video or audio — is a transcode (an audio-only transcode
 * shown as the greener Direct Stream contradicted the enforcer, which
 * terminates it under the Audio/Any criteria); a `copy` decision is a remux
 * (the container changes, nothing is re-encoded); anything else is direct
 * play. Null when nothing is known — every native history row; a live session
 * with no transcode details is direct play, which the caller supplies.
 *
 * The History page decided on `isTranscode` alone, so a row whose flag was
 * false but whose audio decision was "transcode" read as direct.
 */
export function streamDecision(input: StreamDecisionInput | null | undefined): StreamDecision | null {
  if (!input) return null;
  const { isTranscode, videoDecision, audioDecision } = input;
  if (isTranscode == null && !videoDecision && !audioDecision) return null;
  let kind: StreamDecisionKind;
  if (isTranscode || videoDecision === "transcode" || audioDecision === "transcode") kind = "transcode";
  else if (videoDecision === "copy" || audioDecision === "copy") kind = "direct-stream";
  else kind = "direct-play";
  return { kind, label: LABELS[kind] };
}

/** The decision chip's colours: amber for a transcode, sky for a remux, green for direct play. */
export function decisionChipClass(kind: StreamDecisionKind): string {
  switch (kind) {
    case "transcode":
      return "bg-amber-dim text-amber border-amber/25";
    case "direct-stream":
      return "bg-sky-dim text-sky border-sky/25";
    case "direct-play":
      return "bg-green-dim text-green border-green/25";
  }
}
