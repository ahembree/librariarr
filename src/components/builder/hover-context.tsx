"use client";

import { createContext, useContext } from "react";

export interface BuilderHover {
  kind: "rule" | "group";
  id: string;
}

/**
 * Lets builder rows (and group drag handles) report what the pointer is
 * over so the Logic Preview can spotlight the matching pseudocode line or
 * group range. Only the (stable) setter crosses the context, so hovering
 * never re-renders the rows themselves — the changing value goes to the
 * panel via props.
 */
export const BuilderHoverSetterContext = createContext<(hover: BuilderHover | null) => void>(
  () => {},
);

export function useBuilderHoverSetter() {
  return useContext(BuilderHoverSetterContext);
}
