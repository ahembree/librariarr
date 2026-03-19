"use client";

import { useState } from "react";
import { Plus, LayoutDashboard } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  CARD_REGISTRY,
  type DashboardTab,
  type CustomCardConfig,
} from "@/lib/dashboard/card-registry";
import { CustomCardDialog } from "@/components/custom-card-dialog";

interface AddCardDropdownProps {
  tab: DashboardTab;
  existingCards: string[];
  onAdd: (cardId: string) => void;
  onAddCustom: (config: CustomCardConfig) => void;
}

export function AddCardDropdown({
  tab,
  existingCards,
  onAdd,
  onAddCustom,
}: AddCardDropdownProps) {
  const [dialogOpen, setDialogOpen] = useState(false);

  const existingSet = new Set(existingCards);
  const available = CARD_REGISTRY.filter(
    (card) =>
      card.allowedTabs.includes(tab) && !existingSet.has(card.id)
  );

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="default">
            <Plus className="mr-2 h-4 w-4" />
            Add Card
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="center" className="w-64">
          {/* Custom Card — always at top */}
          <DropdownMenuItem
            onClick={() => setDialogOpen(true)}
            className="cursor-pointer"
          >
            <LayoutDashboard className="mr-2 h-4 w-4 text-muted-foreground" />
            <div className="flex flex-col">
              <span className="text-sm font-medium">Custom Card</span>
              <span className="text-xs text-muted-foreground">
                Create a chart with any dimension and chart type
              </span>
            </div>
          </DropdownMenuItem>
          {available.length > 0 && <DropdownMenuSeparator />}
          {available.map((card) => {
            const Icon = card.icon;
            return (
              <DropdownMenuItem
                key={card.id}
                onClick={() => onAdd(card.id)}
                className="cursor-pointer"
              >
                <Icon className="mr-2 h-4 w-4 text-muted-foreground" />
                <div className="flex flex-col">
                  <span className="text-sm font-medium">{card.label}</span>
                  <span className="text-xs text-muted-foreground">
                    {card.description}
                  </span>
                </div>
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>

      <CustomCardDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onConfirm={(config) => {
          onAddCustom(config);
          setDialogOpen(false);
        }}
      />
    </>
  );
}
