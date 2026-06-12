"use client";

import { createContext, useContext } from "react";

/**
 * Lets builder rows report which rule the pointer is over so the Logic
 * Preview can spotlight the matching pseudocode line. Only the (stable)
 * setter crosses the context, so hovering never re-renders the rows
 * themselves — the changing id goes to the panel via props.
 */
export const BuilderHoverSetterContext = createContext<(id: string | null) => void>(
  () => {},
);

export function useBuilderHoverSetter() {
  return useContext(BuilderHoverSetterContext);
}
