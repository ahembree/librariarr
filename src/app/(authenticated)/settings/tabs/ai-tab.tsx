"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SecretInput } from "@/components/ui/secret-input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CheckCircle, Loader2, Save, Sparkles, XCircle } from "lucide-react";
import { SettingsSection, SetRow } from "../components";
import type { TestResult } from "../types";

export type AiProvider = "openai-compatible" | "anthropic";

export interface AiTabProps {
  aiEnabled: boolean;
  aiProvider: AiProvider;
  aiBaseUrl: string;
  aiApiKey: string;
  aiModel: string;
  aiSaving: boolean;
  aiTesting: boolean;
  aiTestResult: TestResult | null;
  onAiEnabledChange: (value: boolean) => void;
  onAiProviderChange: (value: AiProvider) => void;
  onAiBaseUrlChange: (value: string) => void;
  onAiApiKeyChange: (value: string) => void;
  onAiModelChange: (value: string) => void;
  onSaveAiSettings: () => void;
  onTestAiConnection: () => void;
}

export function AiTab({
  aiEnabled,
  aiProvider,
  aiBaseUrl,
  aiApiKey,
  aiModel,
  aiSaving,
  aiTesting,
  aiTestResult,
  onAiEnabledChange,
  onAiProviderChange,
  onAiBaseUrlChange,
  onAiApiKeyChange,
  onAiModelChange,
  onSaveAiSettings,
  onTestAiConnection,
}: AiTabProps) {
  const isAnthropic = aiProvider === "anthropic";
  const baseUrlPlaceholder = isAnthropic
    ? "https://api.anthropic.com"
    : "https://api.openai.com/v1  ·  or http://localhost:11434/v1";
  const modelPlaceholder = isAnthropic
    ? "e.g. claude-sonnet-5"
    : "e.g. gpt-4o-mini, llama3.1, qwen2.5";

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h2 className="text-xl font-semibold">AI Analysis</h2>
        <p className="text-sm text-muted-foreground">
          Connect an AI provider to ask questions about your library in plain language. Works with any
          OpenAI-compatible endpoint (OpenAI, Ollama, LM Studio, OpenRouter, Groq, vLLM…) or the native
          Anthropic API. The assistant is <strong>read-only</strong> — it can analyze your library but never
          change anything.
        </p>
      </div>

      <SettingsSection
        icon={Sparkles}
        title="AI Assistant"
        description="Your library metadata is sent to the provider you configure. Use a local model (Ollama/LM Studio) to keep everything on your own hardware."
        contentClassName=""
      >
        <SetRow
          title="Enable AI assistant"
          description="Show the AI Analysis page and allow it to answer questions."
          htmlFor="ai-enabled"
          control={<Switch id="ai-enabled" checked={aiEnabled} onCheckedChange={onAiEnabledChange} />}
        />

        <SetRow
          title="Provider"
          description="How the model is reached. Choose OpenAI-compatible for local models."
          control={
            <Select value={aiProvider} onValueChange={(v) => onAiProviderChange(v as AiProvider)}>
              <SelectTrigger className="w-[260px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="openai-compatible">OpenAI-compatible</SelectItem>
                <SelectItem value="anthropic">Anthropic (Claude)</SelectItem>
              </SelectContent>
            </Select>
          }
        />

        <div className="space-y-2 border-b border-border/60 py-4">
          <Label htmlFor="ai-base-url">API base URL</Label>
          <Input
            id="ai-base-url"
            placeholder={baseUrlPlaceholder}
            value={aiBaseUrl}
            onChange={(e) => onAiBaseUrlChange(e.target.value)}
          />
          <p className="text-[13px] text-muted-foreground">
            Leave blank to use the provider default. Point this at a local model&apos;s endpoint (e.g.{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">http://localhost:11434/v1</code> for Ollama).
          </p>
        </div>

        <div className="space-y-2 border-b border-border/60 py-4">
          <Label htmlFor="ai-api-key">API key</Label>
          <SecretInput
            id="ai-api-key"
            placeholder={isAnthropic ? "sk-ant-…" : "sk-…  (optional for local models)"}
            value={aiApiKey}
            onChange={(e) => onAiApiKeyChange(e.target.value)}
          />
          <p className="text-[13px] text-muted-foreground">
            Optional for local models that don&apos;t require authentication. Stored on your server and never
            shown again.
          </p>
        </div>

        <div className="space-y-2 py-4">
          <Label htmlFor="ai-model">Model</Label>
          <Input
            id="ai-model"
            placeholder={modelPlaceholder}
            value={aiModel}
            onChange={(e) => onAiModelChange(e.target.value)}
          />
          <p className="text-[13px] text-muted-foreground">
            The exact model identifier your provider expects. The model must support tool / function calling.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3 pt-2">
          <Button onClick={onSaveAiSettings} disabled={aiSaving}>
            {aiSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
            Save
          </Button>
          <Button
            variant="outline"
            onClick={onTestAiConnection}
            disabled={aiTesting || !aiModel.trim()}
          >
            {aiTesting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Test connection
          </Button>
          {aiTestResult &&
            (aiTestResult.ok ? (
              <span className="flex items-center gap-1 text-sm text-green-500">
                <CheckCircle className="h-4 w-4" /> Connected
              </span>
            ) : (
              <span className="flex items-center gap-1 text-sm text-destructive">
                <XCircle className="h-4 w-4" /> {aiTestResult.error || "Failed"}
              </span>
            ))}
        </div>
      </SettingsSection>
    </div>
  );
}
