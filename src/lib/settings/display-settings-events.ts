import { eventBus } from "@/lib/events/event-bus";

/**
 * Tells every open tab that a display setting changed, so each refetches
 * `/api/settings/shell`. Called by every route that saves one of the values
 * `loadShellSettings` reads.
 */
export function announceDisplaySettingsChanged(userId: string): void {
  eventBus.emit({ type: "display-settings:changed", userId });
}

/** The 409 body for a save based on a revision another tab or device has moved past. */
export function staleRevisionBody(what: string, revision: number) {
  return {
    error: `The ${what} was changed in another tab or on another device. The current one has been loaded; make the change again.`,
    code: "stale_revision" as const,
    revision,
  };
}
