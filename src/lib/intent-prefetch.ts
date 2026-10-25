/**
 * Event handlers that call `onIntent` when the user looks about to open an
 * element: a mouse pointer resting on it for `INTENT_DELAY_MS`, a press, or
 * keyboard focus. A pointer sweeping across a grid on its way elsewhere starts
 * nothing; touch has no hover, so it is the press.
 *
 * Hook-free (the pending timer is kept per element), so a memoised card or a
 * virtualised table row can spread it without state of its own.
 */

export const INTENT_DELAY_MS = 120;

const timers = new WeakMap<Element, ReturnType<typeof setTimeout>>();

function cancel(element: Element): void {
  const timer = timers.get(element);
  if (timer !== undefined) {
    clearTimeout(timer);
    timers.delete(element);
  }
}

interface IntentHandlers {
  onPointerEnter?: (event: { pointerType: string; currentTarget: Element }) => void;
  onPointerLeave?: (event: { currentTarget: Element }) => void;
  onPointerDown?: () => void;
  onFocus?: () => void;
}

export function intentHandlers(onIntent: (() => void) | undefined): IntentHandlers {
  if (!onIntent) return {};
  return {
    onPointerEnter: (event) => {
      if (event.pointerType !== "mouse") return;
      const element = event.currentTarget;
      cancel(element);
      timers.set(
        element,
        setTimeout(() => {
          timers.delete(element);
          onIntent();
        }, INTENT_DELAY_MS),
      );
    },
    onPointerLeave: (event) => cancel(event.currentTarget),
    onPointerDown: onIntent,
    onFocus: onIntent,
  };
}
