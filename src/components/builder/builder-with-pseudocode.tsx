"use client";

import { useState } from "react";
import { Code } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { PseudocodePanel } from "./pseudocode-panel";
import type { BaseRule, BaseGroup, BuilderConfig } from "./types";

interface BuilderWithPseudocodeProps<
  R extends BaseRule,
  G extends BaseGroup<R>,
> {
  groups: G[];
  config: BuilderConfig<R, G>;
  children: React.ReactNode;
}

export function BuilderWithPseudocode<
  R extends BaseRule,
  G extends BaseGroup<R>,
>({ groups, config, children }: BuilderWithPseudocodeProps<R, G>) {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <>
      {/* Desktop: side-by-side 2/3 + 1/3 grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2">{children}</div>
        <div className="hidden lg:block">
          <div className="sticky top-6 max-h-[calc(100vh-8rem)] overflow-y-auto">
            <PseudocodePanel groups={groups} config={config} />
          </div>
        </div>
      </div>

      {/* Mobile/tablet: collapsible section below */}
      <div className="lg:hidden mt-4">
        <Collapsible open={mobileOpen} onOpenChange={setMobileOpen}>
          <CollapsibleTrigger asChild>
            <Button variant="outline" className="w-full">
              <Code className="mr-2 h-4 w-4" />
              {mobileOpen ? "Hide" : "Show"} Logic Preview
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-3">
            <PseudocodePanel groups={groups} config={config} />
          </CollapsibleContent>
        </Collapsible>
      </div>
    </>
  );
}
