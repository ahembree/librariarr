"use client";

import { Eye } from "lucide-react";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import type { CardDisplayPreferences, ToggleConfig } from "@/hooks/use-card-display";

interface CardDisplayControlProps {
  prefs: CardDisplayPreferences;
  config: ToggleConfig;
  onToggle: (section: "badges" | "metadata" | "servers", key: string, visible: boolean) => void;
}

export function CardDisplayControl({ prefs, config, onToggle }: CardDisplayControlProps) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          className="flex items-center gap-1 rounded-lg border p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          title="Card display options"
          aria-label="Card display options"
        >
          <Eye className="h-4 w-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-56 p-3">
        <div className="space-y-3">
          {config.badges.length > 0 && (
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-2">Badges</p>
              <div className="space-y-2">
                {config.badges.map((item) => (
                  <div key={item.key} className="flex items-center justify-between">
                    <Label htmlFor={`badge-${item.key}`} className="text-sm font-normal cursor-pointer">
                      {item.label}
                    </Label>
                    <Switch
                      id={`badge-${item.key}`}
                      size="sm"
                      checked={prefs.badges[item.key] ?? true}
                      onCheckedChange={(checked) => onToggle("badges", item.key, checked)}
                    />
                  </div>
                ))}
              </div>
            </div>
          )}

          {config.metadata.length > 0 && (
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-2">Metadata</p>
              <div className="space-y-2">
                {config.metadata.map((item) => (
                  <div key={item.key} className="flex items-center justify-between">
                    <Label htmlFor={`meta-${item.key}`} className="text-sm font-normal cursor-pointer">
                      {item.label}
                    </Label>
                    <Switch
                      id={`meta-${item.key}`}
                      size="sm"
                      checked={prefs.metadata[item.key] ?? true}
                      onCheckedChange={(checked) => onToggle("metadata", item.key, checked)}
                    />
                  </div>
                ))}
              </div>
            </div>
          )}

          <div>
            <p className="text-xs font-medium text-muted-foreground mb-2">Other</p>
            <div className="flex items-center justify-between">
              <Label htmlFor="servers" className="text-sm font-normal cursor-pointer">
                Server Chips
              </Label>
              <Switch
                id="servers"
                size="sm"
                checked={prefs.servers}
                onCheckedChange={(checked) => onToggle("servers", "", checked)}
              />
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
