"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Sparkles, Send, Loader2, Square, User, Settings as SettingsIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MarkdownLite } from "@/components/ai/markdown-lite";
import { EvidenceCard } from "@/components/ai/evidence-card";
import type { AiEvidence, AiChatResponse } from "@/lib/ai/types";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  evidence?: AiEvidence[];
}

const SUGGESTIONS = [
  "Give me an overview of my library",
  "Is there a pattern between resolution and video codec?",
  "What are the most popular shows right now?",
  "What are my 10 largest movies?",
  "What movies have I never watched?",
  "How has my library grown over the past year?",
];

type ConfigState = { loading: boolean; enabled: boolean; configured: boolean };

export default function AiAnalysisPage() {
  const [config, setConfig] = useState<ConfigState>({ loading: true, enabled: false, configured: false });
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [status, setStatus] = useState("");
  const [steps, setSteps] = useState<string[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/settings/ai");
        const data = await res.json();
        setConfig({
          loading: false,
          enabled: !!data.enabled,
          configured: !!data.model,
        });
      } catch {
        setConfig({ loading: false, enabled: false, configured: false });
      }
    })();
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, status, steps]);

  const send = useCallback(
    async (text: string) => {
      const q = text.trim();
      if (!q || streaming) return;

      const history: ChatMessage[] = [...messages, { role: "user", content: q }];
      setMessages(history);
      setInput("");
      setStreaming(true);
      setStatus("Starting…");
      setSteps([]);

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const resp = await fetch("/api/ai/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: history.map((m) => ({ role: m.role, content: m.content })) }),
          signal: controller.signal,
        });

        if (!resp.ok || !resp.body) {
          const err = await resp.json().catch(() => null);
          throw new Error(err?.error ?? "Request failed");
        }

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let final: AiChatResponse | null = null;

        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let idx: number;
            while ((idx = buffer.indexOf("\n")) !== -1) {
              const line = buffer.slice(0, idx);
              buffer = buffer.slice(idx + 1);
              if (!line.trim()) continue;
              const ev = JSON.parse(line);
              if (ev.type === "status") setStatus(ev.label);
              else if (ev.type === "tool") setSteps((prev) => [...prev, ev.label]);
              else if (ev.type === "result") final = ev.result as AiChatResponse;
              else if (ev.type === "error") throw new Error(ev.message);
            }
          }
        } finally {
          reader.cancel().catch(() => {});
        }

        if (final) {
          setMessages((prev) => [...prev, { role: "assistant", content: final!.answer, evidence: final!.evidence }]);
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          setMessages((prev) => [
            ...prev,
            {
              role: "assistant",
              content: `⚠️ ${err instanceof Error ? err.message : "Something went wrong."}`,
              evidence: [],
            },
          ]);
        }
      } finally {
        setStreaming(false);
        setStatus("");
        setSteps([]);
        abortRef.current = null;
      }
    },
    [messages, streaming],
  );

  const stop = () => abortRef.current?.abort();

  return (
    <div className="flex h-full flex-col p-4 sm:p-6 lg:p-8">
      <div className="mb-4 flex flex-col gap-1">
        <h1 className="flex items-center gap-2 text-2xl font-bold font-display tracking-tight sm:text-3xl">
          <Sparkles className="h-6 w-6 text-primary" />
          AI Analysis
        </h1>
        <p className="text-muted-foreground">
          Ask questions about your media library in plain language. Answers are grounded in your own data
          — the assistant is read-only and can&apos;t change anything.
        </p>
      </div>

      {config.loading ? (
        <div className="flex flex-1 items-center justify-center text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : !config.enabled || !config.configured ? (
        <NotConfigured configured={config.configured} enabled={config.enabled} />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-4">
          {/* Conversation */}
          <div ref={scrollRef} className="min-h-0 flex-1 space-y-5 overflow-y-auto rounded-xl border bg-card/30 p-4">
            {messages.length === 0 && !streaming && (
              <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
                <Sparkles className="h-8 w-8 text-primary/70" />
                <p className="max-w-md text-sm text-muted-foreground">
                  Try one of these, or ask your own question:
                </p>
                <div className="flex max-w-2xl flex-wrap justify-center gap-2">
                  {SUGGESTIONS.map((s) => (
                    <button
                      key={s}
                      onClick={() => send(s)}
                      className="rounded-full border bg-background/60 px-3 py-1.5 text-[13px] text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((m, i) => (
              <MessageRow key={i} message={m} />
            ))}

            {streaming && (
              <div className="flex gap-3">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
                  <Sparkles className="h-4 w-4" />
                </div>
                <div className="flex-1 space-y-1.5 pt-1">
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    {status || "Thinking…"}
                  </div>
                  {steps.map((s, i) => (
                    <div key={i} className="text-xs text-muted-foreground/70">
                      • {s}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Composer */}
          <div className="flex items-end gap-2 rounded-xl border bg-card/50 p-2">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send(input);
                }
              }}
              placeholder="Ask about your library…"
              rows={1}
              disabled={streaming}
              className="max-h-40 min-h-[40px] flex-1 resize-none bg-transparent px-2 py-2 text-sm outline-none placeholder:text-muted-foreground disabled:opacity-60"
            />
            {streaming ? (
              <Button variant="outline" size="icon" onClick={stop} title="Stop">
                <Square className="h-4 w-4" />
              </Button>
            ) : (
              <Button size="icon" onClick={() => send(input)} disabled={!input.trim()} title="Send">
                <Send className="h-4 w-4" />
              </Button>
            )}
          </div>
          <p className="-mt-2 px-1 text-[11px] text-muted-foreground/70">
            The assistant only sees your own library and your servers&apos; watch history — not the outside world.
            Double-check anything important.
          </p>
        </div>
      )}
    </div>
  );
}

function MessageRow({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";
  return (
    <div className="flex gap-3">
      <div
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
          isUser ? "bg-muted text-muted-foreground" : "bg-primary/15 text-primary"
        }`}
      >
        {isUser ? <User className="h-4 w-4" /> : <Sparkles className="h-4 w-4" />}
      </div>
      <div className="min-w-0 flex-1 space-y-3 pt-0.5">
        {isUser ? (
          <p className="whitespace-pre-wrap text-sm">{message.content}</p>
        ) : (
          <MarkdownLite content={message.content} />
        )}
        {message.evidence && message.evidence.length > 0 && (
          <div className="space-y-3">
            {message.evidence.map((ev, i) => (
              <EvidenceCard key={i} evidence={ev} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function NotConfigured({ enabled, configured }: { enabled: boolean; configured: boolean }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 rounded-xl border border-dashed bg-card/20 p-8 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
        <Sparkles className="h-6 w-6" />
      </div>
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">
          {!configured ? "Set up the AI assistant" : "AI assistant is turned off"}
        </h2>
        <p className="max-w-md text-sm text-muted-foreground">
          {!configured
            ? "Connect an AI provider — a cloud model or a local one like Ollama or LM Studio — to start asking questions about your library."
            : "Enable the AI assistant to start asking questions about your library."}
        </p>
      </div>
      <Button asChild>
        <Link href="/settings#ai">
          <SettingsIcon className="mr-2 h-4 w-4" />
          Go to AI settings
        </Link>
      </Button>
      {enabled && !configured && null}
    </div>
  );
}
