"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

/**
 * "Exclude from lifecycle actions" — the optional-reason prompt before an
 * exception is filed. Open while `itemLabel` is set (how the row names the
 * item); `onConfirm` gets the reason ("" for none) and the dialog closes.
 */
export function ExcludeReasonDialog({
  itemLabel,
  onCancel,
  onConfirm,
}: {
  itemLabel: string | null;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  // A new item starts with an empty reason.
  const [forLabel, setForLabel] = useState(itemLabel);
  if (forLabel !== itemLabel) {
    setForLabel(itemLabel);
    setReason("");
  }

  const confirm = () => {
    if (itemLabel === null) return;
    onConfirm(reason);
  };

  return (
    <Dialog open={itemLabel !== null} onOpenChange={(open) => { if (!open) onCancel(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Exclude from lifecycle actions</DialogTitle>
          <DialogDescription>
            &quot;{itemLabel}&quot; will be excluded from all lifecycle rules. Optionally provide a reason.
          </DialogDescription>
        </DialogHeader>
        <Input
          placeholder="Reason (optional)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") confirm();
          }}
        />
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={confirm}>Exclude</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
