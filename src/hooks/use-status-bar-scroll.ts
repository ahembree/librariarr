"use client";

import { useEffect } from "react";
import { findScrollContainer } from "@/lib/scroll-utils";

/**
 * Makes the native iOS "tap status bar to scroll to top" gesture work with
 * our nested scroll container architecture.
 *
 * The trick: iOS only fires the gesture when the *document* is scrollable.
 * We add 1px of extra height to make the document barely scrollable, keep it
 * scrolled to 1px, then detect when iOS snaps it back to 0 (the status bar tap).
 * When that happens, we scroll our actual content container to top.
 */
export function useStatusBarScroll() {
  useEffect(() => {
    // Only needed on touch devices
    if (!("ontouchstart" in window) && navigator.maxTouchPoints === 0) return;

    // Make the document scrollable by 1px
    const spacer = document.createElement("div");
    spacer.style.height = "1px";
    spacer.style.width = "1px";
    spacer.style.position = "absolute";
    spacer.style.bottom = "-1px";
    spacer.style.pointerEvents = "none";
    document.body.appendChild(spacer);
    document.body.style.position = "relative";
    document.body.style.minHeight = "calc(100vh + 1px)";

    // Start scrolled to 1px so tapping the status bar can scroll to 0
    window.scrollTo(0, 1);

    // Track recent touch activity to distinguish genuine status bar taps
    // from scroll-chaining leaks (where overscroll-contain fails to fully
    // prevent touch events from reaching the window on iOS).
    let lastTouchTime = 0;
    function onTouchStart() {
      lastTouchTime = Date.now();
    }
    function onTouchEnd() {
      lastTouchTime = Date.now();
    }

    function onScroll() {
      if (window.scrollY === 0) {
        // If the user was actively touching the screen, this is likely
        // scroll chaining rather than an actual status bar tap. Just reset
        // window scroll without scrolling the content container to top.
        if (Date.now() - lastTouchTime < 500) {
          requestAnimationFrame(() => {
            window.scrollTo(0, 1);
          });
          return;
        }

        // Status bar tap detected — scroll our content container to top
        findScrollContainer()?.scrollTo({ top: 0, behavior: "smooth" });

        // Reset to 1px so the gesture can fire again
        requestAnimationFrame(() => {
          window.scrollTo(0, 1);
        });
      }
    }

    document.addEventListener("touchstart", onTouchStart, { passive: true });
    document.addEventListener("touchend", onTouchEnd, { passive: true });
    window.addEventListener("scroll", onScroll, { passive: true });

    return () => {
      document.removeEventListener("touchstart", onTouchStart);
      document.removeEventListener("touchend", onTouchEnd);
      window.removeEventListener("scroll", onScroll);
      spacer.remove();
      document.body.style.position = "";
      document.body.style.minHeight = "";
    };
  }, []);
}
