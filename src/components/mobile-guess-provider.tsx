"use client";

import type { ReactNode } from "react";
import { MobileGuessContext } from "@/hooks/use-is-mobile";

/** Hands `useIsMobile` the server's guess for the renders before hydration ends. */
export function MobileGuessProvider({ guess, children }: { guess: boolean; children: ReactNode }) {
  return <MobileGuessContext.Provider value={guess}>{children}</MobileGuessContext.Provider>;
}
